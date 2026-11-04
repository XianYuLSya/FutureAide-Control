import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPowerShellDriver} from '../src/claude-host.mjs';
const exec=promisify(execFile);
test('UI document selection rejects hidden history and prioritizes the current focus/title',async()=>{
 const driver=fileURLToPath(new URL('../scripts/claude-host.ps1',import.meta.url));
 const code=String.raw`
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:DRIVER,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'driver parse failed'}
foreach($f in $ast.EndBlock.Statements){if($f -is [System.Management.Automation.Language.FunctionDefinitionAst]){. ([scriptblock]::Create($f.Extent.Text))}}
$old=[pscustomobject]@{Name='Old chat';Descendants=900;Visible=$false;FocusWithin=$false;WindowTitleMatch=$false}
$current=[pscustomobject]@{Name='Claude';Descendants=165;Visible=$true;FocusWithin=$false;WindowTitleMatch=$true}
$other=[pscustomobject]@{Name='Other chat';Descendants=800;Visible=$true;FocusWithin=$false;WindowTitleMatch=$false}
if((Select-WebDocument @($old,$current,$other)).Name -ne 'Claude'){throw 'wrong active document'}
$other.FocusWithin=$true
if((Select-WebDocument @($old,$current,$other)).Name -ne 'Other chat'){throw 'focus ignored'}
if('The transcript says Trust this workspace but no prompt is open' -match (Get-TrustPattern)){throw 'body text became trust prompt'}
if('Trust this workspace?' -notmatch (Get-TrustPattern)){throw 'heading not recognized'}
Add-Type -TypeDefinition 'namespace FutureAideHost { public static class Win32 { public static long Foreground=11; public static System.IntPtr GetForegroundWindow(){return new System.IntPtr(Foreground);} } }'
$window=[pscustomobject]@{Current=[pscustomobject]@{NativeWindowHandle=11}}
Assert-InputWindow $window
[FutureAideHost.Win32]::Foreground=12
$rejected=$false
try{Assert-InputWindow $window}catch{$rejected=$_.Exception.Message -eq 'input-window-not-foreground'}
if(-not $rejected){throw 'foreign window accepted'}
$marker='[FutureAide Control request request-123 ' + [char]0x00b7 + ' binding original-nonce]'
if((Get-DispatchMarker ($marker + [Environment]::NewLine + 'payload')) -ne $marker){throw 'marker extraction failed'}
Assert-ComposerMarker ($marker + ' text') $marker
foreach($wrong in @('user draft',$marker.Replace('original-nonce','another-nonce'))){
 $rejected=$false
 try{Assert-ComposerMarker $wrong $marker}catch{$rejected=$_.Exception.Message -eq 'composer-request-marker-mismatch'}
 if(-not $rejected){throw 'foreign composer accepted'}
}
'ok'
`;
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{env:{...process.env,DRIVER:driver},windowsHide:true});
 assert.match(stdout,/ok/);
});
test('UI bridge stores results under its project and exposes only proven pre-Enter failure',async()=>{
 const root=fileURLToPath(new URL(`../clean/validation/claude-uia/${randomUUID()}/`,import.meta.url));
 await mkdir(path.join(root,'scripts'),{recursive:true});
 const script=path.join(root,'scripts','fixture.ps1');
 await writeFile(script,String.raw`param($Action,$OutFile)
$null=[Console]::In.ReadToEnd()
Start-Sleep -Milliseconds 150
[IO.File]::WriteAllText($OutFile,'{"ok":false,"code":"ui-bridge-error","message":"clipboard busy","attempted":false,"stage":"clipboard-set"}')`);
 const driver=createPowerShellDriver({script,timeoutMs:1});
 await assert.rejects(driver.submit({prompt:'fixture'}),error=>error.attempted===false&&error.prewriteEvidence.enterAttempted===false);
 assert.equal((await readdir(path.join(root,'.runtime','claude-host-results'))).length,1);
});
