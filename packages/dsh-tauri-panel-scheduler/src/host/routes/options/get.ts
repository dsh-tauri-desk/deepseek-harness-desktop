import { defineEventHandler } from 'dsh-tauri'
import { options } from '../../service/options'

export default defineEventHandler(async () => options.resolve())
