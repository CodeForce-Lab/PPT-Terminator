# Copyright (c) 2026 CodeForce-Lab
# Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
# 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

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
