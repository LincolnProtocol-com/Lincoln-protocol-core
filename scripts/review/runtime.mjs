// SPDX-License-Identifier: Apache-2.0
// Preserve the exact RC.3 compiler source-unit names inside its release capsule.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
import {CURRENT_RELEASE_DIRECTORY} from './layout.mjs';
export const RELEASE_DIRECTORY=CURRENT_RELEASE_DIRECTORY;
export const LEGACY_RELEASE_DIRECTORY='releases/rc2';
const need=(ok,code)=>{if(!ok)throw new Error(code);};
const sha=x=>createHash('sha256').update(x).digest('hex');
async function regular(file){
  const stat=await fs.lstat(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&await fs.realpath(file)===file,'REVIEW_DEPENDENCY_LOCK_INVALID');
  return fs.readFile(file);
}
function sameDependencyLock(rootBytes,releaseBytes,releaseDirectory){
  if(releaseDirectory===RELEASE_DIRECTORY)return sha(rootBytes)===sha(releaseBytes);
  // RC.2 remains immutable. Only its two package-version labels differ from
  // RC.3; every dependency, resolved URL, integrity, engine and other lock
  // property must still match exactly. Never normalize dependency versions.
  const current=JSON.parse(rootBytes),historical=JSON.parse(releaseBytes);
  if(current.version!=='0.1.0-rc.3'||current.packages?.['']?.version!=='0.1.0-rc.3'
    ||historical.version!=='0.1.0-rc.2'||historical.packages?.['']?.version!=='0.1.0-rc.2')return false;
  delete current.version;delete historical.version;
  delete current.packages[''].version;delete historical.packages[''].version;
  return isDeepStrictEqual(current,historical);
}
export async function ensureReleaseDependencies({root=ROOT,releaseDirectory=RELEASE_DIRECTORY}={}){
  need([RELEASE_DIRECTORY,LEGACY_RELEASE_DIRECTORY].includes(releaseDirectory),'REVIEW_RELEASE_DIRECTORY_INVALID');
  root=await fs.realpath(root);const release=path.join(root,releaseDirectory);
  need(await fs.realpath(release)===release,'REVIEW_CAPSULE_PATH_INVALID');
  need(sameDependencyLock(await regular(path.join(root,'package-lock.json')),await regular(path.join(release,'package-lock.json')),releaseDirectory),'REVIEW_DEPENDENCY_LOCK_CHANGED');
  const source=path.join(root,'node_modules'),target=path.join(release,'node_modules');
  need((await fs.lstat(source)).isDirectory()&&await fs.realpath(source)===source,'REVIEW_RUN_NPM_CI_FIRST');
  try{need((await fs.lstat(target)).isDirectory()&&await fs.realpath(target)===target,'REVIEW_DEPENDENCY_DIRECTORY_INVALID');return release;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(release,'.lincoln-deps-'+randomUUID());
  try{
    // Regular copies are necessary: the original production gate rejects linked source files.
    // Preserve npm's relative .bin launchers; their targets are copied regular
    // package files. Compiler source units are independently checked as regular
    // files by each frozen capsule's release gate.
    await fs.cp(source,temporary,{recursive:true,force:false,errorOnExist:true,verbatimSymlinks:true});
    try{await fs.rename(temporary,target);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
  need((await fs.lstat(target)).isDirectory()&&await fs.realpath(target)===target,'REVIEW_DEPENDENCY_DIRECTORY_INVALID');
  return release;
}
