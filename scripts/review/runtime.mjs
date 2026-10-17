// SPDX-License-Identifier: Apache-2.0
// Preserve the exact RC.2 compiler source-unit names inside its release capsule.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const RELEASE_DIRECTORY='releases/rc2';
const need=(ok,code)=>{if(!ok)throw new Error(code);};
const sha=x=>createHash('sha256').update(x).digest('hex');
export async function ensureReleaseDependencies({root=ROOT}={}){
  root=await fs.realpath(root);const release=path.join(root,RELEASE_DIRECTORY);
  need(await fs.realpath(release)===release,'REVIEW_CAPSULE_PATH_INVALID');
  need(sha(await fs.readFile(path.join(root,'package-lock.json')))===sha(await fs.readFile(path.join(release,'package-lock.json'))),'REVIEW_DEPENDENCY_LOCK_CHANGED');
  const source=path.join(root,'node_modules'),target=path.join(release,'node_modules');
  need((await fs.lstat(source)).isDirectory()&&await fs.realpath(source)===source,'REVIEW_RUN_NPM_CI_FIRST');
  try{need((await fs.lstat(target)).isDirectory()&&await fs.realpath(target)===target,'REVIEW_DEPENDENCY_DIRECTORY_INVALID');return release;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(release,'.lincoln-deps-'+randomUUID());
  try{
    // Regular copies are necessary: the original production gate rejects linked source files.
    await fs.cp(source,temporary,{recursive:true,force:false,errorOnExist:true});
    try{await fs.rename(temporary,target);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
  need((await fs.lstat(target)).isDirectory()&&await fs.realpath(target)===target,'REVIEW_DEPENDENCY_DIRECTORY_INVALID');
  return release;
}
