# Copyright (c) 2026 CodeForce-Lab
# All rights reserved.
# 未经许可禁止商用、二次分发

param([ValidateSet('protect','unprotect')][string]$Action)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$inputText=[Console]::In.ReadToEnd()
$entropy=[Text.Encoding]::UTF8.GetBytes('LocalPptStudio-Key-v1')
if($Action -eq 'protect'){
 $bytes=[Text.Encoding]::UTF8.GetBytes($inputText)
 $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [Console]::Out.Write([Convert]::ToBase64String($result))
}else{
 $bytes=[Convert]::FromBase64String($inputText)
 $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
 [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))
}
