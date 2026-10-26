export async function readSecret(prompt:string):Promise<string>{
 if(!process.stdin.isTTY||!process.stdin.setRawMode)throw new Error('Запустите команду в интерактивном терминале');
 return new Promise((resolve,reject)=>{
  let value='';const wasRaw=Boolean(process.stdin.isRaw);
  process.stdout.write(prompt);
  const finish=(error?:Error)=>{
   process.stdin.off('data',onData);process.stdin.setRawMode(wasRaw);process.stdin.pause();process.stdout.write('\n');
   if(error)reject(error);else resolve(value);
  };
  const onData=(chunk:string)=>{
   for(const char of chunk){
    if(char==='\r'||char==='\n'){finish();return;}
    if(char==='\u0003'){finish(new Error('Ввод отменён'));return;}
    if(char==='\u007f'||char==='\b'){value=[...value].slice(0,-1).join('');continue;}
    if(char>=' ')value+=char;
   }
  };
  process.stdin.setEncoding('utf8');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',onData);
 });
}
