# Copyright (c) 2026 CodeForce-Lab
# Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
# 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

param(
 [Parameter(Mandatory=$true)][string]$InputPath,
 [Parameter(Mandatory=$true)][string]$ReferencePath,
 [Parameter(Mandatory=$true)][string]$OutputPath,
 [Parameter(Mandatory=$true)][ValidateRange(1,5)][int]$KeepCount,
 [Parameter(Mandatory=$true)][ValidateRange(5,40)][int]$ExpectedCount
)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $OutputPath){throw 'Output already exists'}
$app=$null;$deck=$null;$owned=(@(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -eq 0)
try {
 $app=New-Object -ComObject PowerPoint.Application
 $deck=$app.Presentations.Open($InputPath,-1,0,0)
 if($deck.Slides.Count -ne $ExpectedCount){throw 'Unexpected generated slide count'}
 for($i=$KeepCount;$i -ge 1;$i--){$deck.Slides.Item($i).Delete()}
 $added=$deck.Slides.InsertFromFile($ReferencePath,0,1,$KeepCount)
 if($added -ne $KeepCount -or $deck.Slides.Count -ne $ExpectedCount){throw 'Reference merge changed final slide count'}
 $deck.SaveAs($OutputPath,24)
 Write-Output 'Reference prefix preserved; exact final slide count verified.'
}finally{
 if($deck){$deck.Saved=-1;$deck.Close();[void][Runtime.InteropServices.Marshal]::ReleaseComObject($deck)}
 if($app){if($owned -and $app.Presentations.Count -eq 0){$app.Quit()};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)}
 [GC]::Collect();[GC]::WaitForPendingFinalizers()
}
