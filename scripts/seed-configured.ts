import {loadEnvConfig} from '@next/env';
loadEnvConfig(process.cwd());
import('./seed').catch(e=>{console.error(e);process.exit(1);});
