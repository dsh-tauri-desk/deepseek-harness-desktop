import { defineEventHandler } from 'dsh-tauri'
import { archive } from '../../../../service/archive'

export default defineEventHandler(() => archive.deleteAll())
