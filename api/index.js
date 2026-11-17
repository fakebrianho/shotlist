// Vercel Function: every /api?op=… request lands here.
import { handle } from '../server/handler.js';

export const GET = handle;
export const POST = handle;
