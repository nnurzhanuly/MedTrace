import {loadEnvConfig} from '@next/env';
loadEnvConfig(process.cwd());
if((process.env.MEDTRACE_REQUIRE_POSTGRES==='1'||process.argv.includes('--require-postgres'))&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL отсутствует: PostgreSQL не подключён');
import('../src/lib/db').then(({migrate})=>migrate()).then(()=>{console.log(`Migrations applied: ${process.env.DATABASE_URL?'PostgreSQL':'local PGlite'}`);process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});
