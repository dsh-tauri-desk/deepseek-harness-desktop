//! 插件子进程输出的有界读取与尾部捕获。
//!
//! 第三方安装脚本可以输出任意长度的内容，读取层必须在单行、总量和事件频率
//! 进入 UI/错误解析前就设上限。捕获保留尾部，因为 pnpm 的诊断和 allowBuilds
//! 建议通常出现在命令输出末尾。

use std::io::Read;
use std::sync::{Arc, Mutex};

/// 单次插件命令最多保留的输出字节数。
pub(crate) const MAX_CAPTURED_BYTES: usize = 256 * 1024;
/// 单行最多保留的输出字节数。
pub(crate) const MAX_OUTPUT_LINE_BYTES: usize = 16 * 1024;
const READ_CHUNK_BYTES: usize = 8 * 1024;

pub(crate) type CapturedOutput = Arc<Mutex<String>>;

pub(crate) fn new_capture() -> CapturedOutput {
    Arc::new(Mutex::new(String::new()))
}

/// 把文本追加到有界尾部缓冲，保证输出大小不会随命令运行时间增长。
pub(crate) fn append_captured(captured: &CapturedOutput, text: &str) {
    let Ok(mut output) = captured.lock() else {
        return;
    };
    append_bounded_string(&mut output, text);
}

pub(crate) fn append_bounded_string(output: &mut String, text: &str) {
    output.push_str(text);
    if output.len() <= MAX_CAPTURED_BYTES {
        return;
    }

    let mut remove = output.len() - MAX_CAPTURED_BYTES;
    while remove < output.len() && !output.is_char_boundary(remove) {
        remove += 1;
    }
    output.drain(..remove);
}

/// 在固定大小的读取缓冲上切分输出行，避免 `BufRead::lines()` 为超长单行分配
/// 无界内存。回调只收到截断后的行。
pub(crate) fn read_bounded_lines<R: Read>(mut reader: R, mut on_line: impl FnMut(String)) {
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    let mut line = Vec::with_capacity(MAX_OUTPUT_LINE_BYTES.min(READ_CHUNK_BYTES));
    let mut truncated = false;

    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for byte in &chunk[..read] {
            match *byte {
                b'\n' => {
                    on_line(render_line(&line, truncated));
                    line.clear();
                    truncated = false;
                }
                b'\r' => {}
                byte => {
                    if line.len() < MAX_OUTPUT_LINE_BYTES {
                        line.push(byte);
                    } else {
                        truncated = true;
                    }
                }
            }
        }
    }

    if !line.is_empty() || truncated {
        on_line(render_line(&line, truncated));
    }
}

fn render_line(bytes: &[u8], truncated: bool) -> String {
    let mut line = String::from_utf8_lossy(bytes).into_owned();
    if truncated {
        line.push_str(" [output truncated]");
    }
    line
}

/// 在线程中读取管道，捕获有界尾部并执行可选的实时回调。
pub(crate) fn spawn_bounded_reader<R, F>(
    reader: R,
    captured: CapturedOutput,
    mut on_line: F,
) -> std::thread::JoinHandle<()>
where
    R: Read + Send + 'static,
    F: FnMut(String) + Send + 'static,
{
    std::thread::spawn(move || {
        read_bounded_lines(reader, |line| {
            append_captured(&captured, &line);
            append_captured(&captured, "\n");
            on_line(line);
        });
    })
}

pub(crate) fn drain_captured(captured: CapturedOutput) -> String {
    captured
        .lock()
        .map(|mut output| std::mem::take(&mut *output))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    struct InterruptOnce {
        interrupted: bool,
        inner: Cursor<Vec<u8>>,
    }

    impl Read for InterruptOnce {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if !self.interrupted {
                self.interrupted = true;
                return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
            }
            self.inner.read(buffer)
        }
    }

    #[test]
    fn long_line_is_bounded_before_callback() {
        let input = vec![b'x'; MAX_OUTPUT_LINE_BYTES * 8];
        let mut lines = Vec::new();
        read_bounded_lines(Cursor::new(input), |line| lines.push(line));
        assert_eq!(lines.len(), 1);
        assert!(lines[0].len() <= MAX_OUTPUT_LINE_BYTES + 20);
        assert!(lines[0].ends_with("[output truncated]"));
    }

    #[test]
    fn captured_output_keeps_only_the_tail() {
        let capture = new_capture();
        append_captured(&capture, &"a".repeat(MAX_CAPTURED_BYTES));
        append_captured(&capture, "tail");
        let output = drain_captured(capture);
        assert!(output.len() <= MAX_CAPTURED_BYTES);
        assert!(output.ends_with("tail"));
    }

    #[test]
    fn interrupted_reads_are_retried() {
        let reader = InterruptOnce {
            interrupted: false,
            inner: Cursor::new(b"after interrupt\n".to_vec()),
        };
        let mut lines = Vec::new();

        read_bounded_lines(reader, |line| lines.push(line));

        assert_eq!(lines, vec!["after interrupt"]);
    }

    #[test]
    fn bounded_reader_handle_can_be_joined_before_draining() {
        let capture = new_capture();
        let reader =
            spawn_bounded_reader(Cursor::new(b"complete\n".to_vec()), capture.clone(), |_| {});

        reader.join().expect("output reader should finish");

        assert_eq!(drain_captured(capture), "complete\n");
    }
}
