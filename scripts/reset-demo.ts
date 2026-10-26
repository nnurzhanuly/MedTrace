// Destructive reset is intentionally explicit and limited to the local PGlite demo directory.
import {rm} from 'node:fs/promises';import path from 'node:path';import {loadEnvConfig} from '@next/env';
loadEnvConfig(process.cwd());
if(process.env.DATABASE_URL||process.env.NODE_ENV==='production')throw new Error('Reset is only available for local demo data');
if(process.env.CONFIRM_DEMO_RESET!=='yes')throw new Error('Set CONFIRM_DEMO_RESET=yes to reset local demo data');
rm(path.join(process.cwd(),'data','medtrace'),{recursive:true,force:true}).then(()=>console.log('Local demo database removed. Run npm run db:seed.'));
