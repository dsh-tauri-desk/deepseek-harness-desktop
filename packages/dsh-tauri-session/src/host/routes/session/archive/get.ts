import { defineEventHandler } from 'dsh-tauri'
import { ledger } from '../../../service/ledger'

export default defineEventHandler(() => ledger.load())
