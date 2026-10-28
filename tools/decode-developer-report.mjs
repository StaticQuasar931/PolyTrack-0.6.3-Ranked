import {open, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {CODEC_LIMITS, decodeDiagnosticReport} from './diagnostic-codec.mjs';

export async function decodeFile(input, output) {
 const handle = await open(input, 'r');
 let text;
 try {
  if ((await handle.stat()).size > CODEC_LIMITS.inputBytes) throw Error('Input limit exceeded');
  // A bounded read also covers files growing after stat, including special files.
  const buffer = Buffer.alloc(CODEC_LIMITS.inputBytes + 1);
  let length = 0;
  while (length < buffer.length) {
   const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
   if (!bytesRead) break;
   length += bytesRead;
  }
  if (length > CODEC_LIMITS.inputBytes) throw Error('Input limit exceeded');
  text = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, length));
 } finally { await handle.close(); }
 const report = decodeDiagnosticReport(text);
 const readable = JSON.stringify(report, null, 2) + '\n';
 if (Buffer.byteLength(readable) > CODEC_LIMITS.outputBytes) throw Error('Readable output limit exceeded');
 // Never overwrite an original report or an existing file.
 if (output) await writeFile(output, readable, {flag: 'wx', mode: 0o600});
 else process.stdout.write(readable);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const args = process.argv.slice(2);
 if (args.length < 1 || args.length > 2 || args[0] === '--help') {
  process.stderr.write('Usage: node tools/decode-developer-report.mjs INPUT.json [OUTPUT.json]\nOffline lossless decoding; compact is not encryption. Existing output files are never overwritten.\n');
  if (args[0] !== '--help') process.exitCode = 1;
 } else {
  decodeFile(...args).catch(() => { process.stderr.write('Decode failed: invalid, oversized, unsupported input, or unavailable output.\n'); process.exitCode = 1; });
 }
}
