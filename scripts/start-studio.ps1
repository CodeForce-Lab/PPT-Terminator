# Copyright (c) 2026 CodeForce-Lab
# Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
# 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$node=Get-Command node.exe -ErrorAction SilentlyContinue
if(-not $node){throw '未检测到Node.js，请安装Node.js 22或更新版本后再启动。'}
if(-not (Test-Path -LiteralPath (Join-Path $project 'node_modules\express'))){throw '依赖缺失，请在ppt-studio文件夹运行npm install后启动。'}
$port=3210
if($env:PPT_STUDIO_PORT){$port=[int]$env:PPT_STUDIO_PORT}
$url='http://127.0.0.1:'+$port
function Check-Studio {
 try {
  $response=Invoke-RestMethod -Uri ($url+'/api/bootstrap') -TimeoutSec 1
  return $response.capabilities.appId -eq 'local-ppt-studio'
 }catch{return $false}
}
if(-not (Check-Studio)){
 $listener=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
 if($listener){throw ('端口'+$port+'已被其他程序占用。请设置PPT_STUDIO_PORT更换端口。')}
 $process=Start-Process -FilePath $node.Source -ArgumentList ('"'+(Join-Path $project 'server.mjs')+'"') -WorkingDirectory $project -PassThru
 $ready=$false
 for($i=0;$i -lt 40;$i++){
  if(Check-Studio){$ready=$true;break}
  if($process.HasExited){break}
  Start-Sleep -Milliseconds 250
 }
 if(-not $ready){throw '本机工作台未能启动，请查看Node窗口中的提示。'}
}
Start-Process $url
Write-Output '启幕PPT已在浏览器打开。关闭Node运行窗口即可停止服务，素材和项目会保留在本机。'
