// SPDX-License-Identifier: Apache-2.0
// Validate a prepared directory; never creates or sends a transaction.
import {configureMainnetOperations} from '../core/mainnet-operations.mjs';
import {ensureReleaseDependencies,LEGACY_RELEASE_DIRECTORY} from '../review/runtime.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),run=promisify(execFile),BASE='abe000c7acd9c26931a17961e1b4bdda083df84e';
const sha=b=>createHash('sha256').update(b).digest('hex'),need=(ok)=>{if(!ok)throw new Error('DEPLOYMENT_SNAPSHOT_MISMATCH');};
async function regular(file){const s=await fs.lstat(file);need(s.isFile()&&!s.isSymbolicLink()&&await fs.realpath(file)===file);return fs.readFile(file);}
export async function checkDeploymentSnapshot({root=ROOT}={}){
 root=await fs.realpath(root);const directory=path.join(root,'.phase1-private/mainnet-deployments/rc2-eth-usdg');need(await fs.realpath(directory)===directory);
 const source=await ensureReleaseDependencies({root,releaseDirectory:LEGACY_RELEASE_DIRECTORY}),opsBytes=await regular(path.join(root,'config/mainnet-operations.json')),ops=JSON.parse(opsBytes),snapshot=JSON.parse(await regular(path.join(directory,'operations-snapshot.json')));
 need(snapshot.base?.commit===BASE&&snapshot.chainId===4663&&snapshot.derivedOperationsSnapshot===true&&snapshot.verbatimFrozenRelease===false&&snapshot.operationsSHA256===sha(opsBytes));
 const expectedConfig=Buffer.from(JSON.stringify(configureMainnetOperations({config:JSON.parse(await regular(path.join(source,'config/phase2-mainnet.json'))),operations:ops}),null,2)+'\n');
 need(sha(expectedConfig)===snapshot.configAfterSHA256);
 const paths=(await run('git',['-C',root,'ls-tree','-r','--name-only',BASE],{timeout:30000})).stdout.trim().split('\n');
 for(const relative of paths){need(!path.isAbsolute(relative)&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'));
  const actual=await regular(path.join(directory,relative));
  if(relative==='config/phase2-mainnet.json'){need(sha(actual)===snapshot.configAfterSHA256);const config=JSON.parse(actual);need(config.deployer.address===ops.deployer.address&&config.deployer.signingAccount===ops.deployer.signingAccount);}
  else need(actual.equals(await regular(path.join(source,relative))));
 }
 return {directory,account:ops.deployer.signingAccount,address:ops.deployer.address,checkedPublicFiles:paths.length,transactionsBroadcast:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==2)throw new Error('USAGE_CHECK_DEPLOYMENT');console.log(JSON.stringify(await checkDeploymentSnapshot()));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
