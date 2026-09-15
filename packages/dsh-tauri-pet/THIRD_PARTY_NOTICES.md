# Third-party asset notices

## dsh-pet

The pet media assets (WebM animations, preview GIFs and `config.jsonc`) are **no
longer bundled or downloaded** by this package. The preset pet catalog
(`src-tauri/resources/preset-pets.json`) only registers the remote URLs, and the
pet window streams them directly from
[`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet) at play time
(macOS reads the HEVC-alpha `.mov` mirror from
[`dsh-tauri-desk/dsh-pet-mov`](https://github.com/dsh-tauri-desk/dsh-pet-mov)).
The catalog pins specific commits for reproducibility.
