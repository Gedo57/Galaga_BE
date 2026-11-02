/**
 * Galaga read-only offline RTP worksheet.
 * Run: node scripts/rtp97-galaga-calibrate.mjs [private-anonymized-qa-settlements.json]
 * No file writes, HTTP requests, database access or wallet changes.
 */
import {readFileSync,statSync} from 'node:fs';
import {calibrateGalagaQaRuns} from '../src/rtp-calibration.js';
const args=process.argv.slice(2);
if(args.length>1)throw Error('GALAGA_CALIBRATION_USAGE');
let rows=[];
if(args.length===1){
  const stat=statSync(args[0]);
  if(!stat.isFile()||stat.size>48*1024*1024)throw Error('GALAGA_CALIBRATION_FILE_TOO_LARGE');
  const data=JSON.parse(readFileSync(args[0],'utf8'));
  if(!data||data.schema!==1||!Array.isArray(data.runs)||
    Object.keys(data).some(k=>!['schema','runs'].includes(k)))
    throw Error('GALAGA_CALIBRATION_DATASET_FORMAT');
  rows=data.runs;
}
process.stdout.write(JSON.stringify(calibrateGalagaQaRuns(rows),null,2)+'\n');
