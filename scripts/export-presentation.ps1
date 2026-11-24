# Copyright (c) 2026 CodeForce-Lab
# Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
# 使用、修改或分发时须保留本声明并署名 CodeForce-Lab。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [switch]$SkipPdf
)

$ErrorActionPreference = 'Stop'

function Release-ComObject($Value) {
    if ($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)) {
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Value) } catch { }
    }
}

function Round-Point([double]$Value) {
    return [Math]::Round($Value, 2)
}

function Inspect-Shape($Shape, $Record, [string]$Index, [double]$SlideWidth, [double]$SlideHeight) {
    $Record.nativeShapeCount++
    $frame = $null
    $range = $null
    $children = $null
    try {
        $left = [double]$Shape.Left
        $top = [double]$Shape.Top
        $width = [double]$Shape.Width
        $height = [double]$Shape.Height
        $type = [int]$Shape.Type
        if ($left -lt -1 -or $top -lt -1 -or $left + $width -gt $SlideWidth + 1 -or $top + $height -gt $SlideHeight + 1) {
            [void]$Record.shapeOverflows.Add([ordered]@{
                shape = $Index
                left = (Round-Point $left)
                top = (Round-Point $top)
                width = (Round-Point $width)
                height = (Round-Point $height)
            })
        }
        if ($type -eq 13 -or $type -eq 11) { $Record.imageCount++ }
        if ($type -eq 3) { $Record.chartCount++ }
        if ([int]$Shape.HasTextFrame -eq -1) {
            $frame = $Shape.TextFrame2
            if ([int]$frame.HasText -eq -1) {
                $Record.nativeTextCount++
                $range = $frame.TextRange
                $boundWidth = [double]$range.BoundWidth
                $boundHeight = [double]$range.BoundHeight
                $boundLeft = [double]$range.BoundLeft
                $boundTop = [double]$range.BoundTop
                $availableWidth = [Math]::Max(0, $width - [double]$frame.MarginLeft - [double]$frame.MarginRight)
                $availableHeight = [Math]::Max(0, $height - [double]$frame.MarginTop - [double]$frame.MarginBottom)
                $textLeft = $left + [double]$frame.MarginLeft
                $textTop = $top + [double]$frame.MarginTop
                $overflow = $boundWidth -gt $availableWidth + 1.25 -or $boundHeight -gt $availableHeight + 1.25 -or
                    $boundLeft -lt $textLeft - 1.25 -or $boundTop -lt $textTop - 1.25 -or
                    $boundLeft + $boundWidth -gt $textLeft + $availableWidth + 1.25 -or
                    $boundTop + $boundHeight -gt $textTop + $availableHeight + 1.25
                $measurement = [ordered]@{
                    shape = $Index
                    text = [string]$range.Text
                    width = (Round-Point $width)
                    height = (Round-Point $height)
                    availableWidth = (Round-Point $availableWidth)
                    availableHeight = (Round-Point $availableHeight)
                    boundWidth = (Round-Point $boundWidth)
                    boundHeight = (Round-Point $boundHeight)
                    boundLeft = (Round-Point $boundLeft)
                    boundTop = (Round-Point $boundTop)
                    overflow = [bool]$overflow
                }
                [void]$Record.textBounds.Add($measurement)
                if ($overflow) { [void]$Record.textOverflows.Add($measurement) }
            }
        }
        if ($type -eq 6) {
            $children = $Shape.GroupItems
            for ($j = 1; $j -le $children.Count; $j++) {
                $child = $null
                try {
                    $child = $children.Item($j)
                    Inspect-Shape $child $Record "$Index.$j" $SlideWidth $SlideHeight
                } finally {
                    Release-ComObject $child
                }
            }
        }
    } catch {
        $Record.inspectionFailures++
    } finally {
        Release-ComObject $range
        Release-ComObject $frame
        Release-ComObject $children
    }
}

try {
    $InputPath = [IO.Path]::GetFullPath($InputPath)
    $OutputDir = [IO.Path]::GetFullPath($OutputDir)
    if (-not [IO.File]::Exists($InputPath) -or -not [IO.Directory]::Exists($OutputDir) -or
        [IO.Path]::GetExtension($InputPath) -ine '.pptx') {
        throw 'Invalid input'
    }
} catch {
    [Console]::Error.WriteLine('需要本地 PPTX 文件和已存在的输出目录。')
    exit 2
}

$qa = [ordered]@{
    version = 1
    engine = 'PowerPoint COM'
    completed = $false
    auditComplete = $false
    slideCount = 0
    nativeTextCount = 0
    nativeShapeCount = 0
    imageCount = 0
    pdfExported = $false
    imageFiles = (New-Object 'System.Collections.Generic.List[string]')
    slides = (New-Object 'System.Collections.Generic.List[object]')
    warnings = (New-Object 'System.Collections.Generic.List[string]')
}
$app = $null
$presentations = $null
$presentation = $null
$slides = $null
$pageSetup = $null
$ownedInstance = $false
$closed = $false
$exitCode = 0

try {
    # Only generated previews inside OutputDir may be replaced.
    foreach ($file in [IO.Directory]::EnumerateFiles($OutputDir)) {
        $name = [IO.Path]::GetFileName($file)
        if ($name -eq 'preview.pdf' -or $name -eq 'qa.json' -or $name -match '^slide-\d+\.png$') {
            [IO.File]::Delete($file)
        }
    }
    $before = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $app = New-Object -ComObject PowerPoint.Application
    try {
        $after = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
        $hwnd = [long]$app.HWND
        if ($before.Count -eq 0 -and $after.Count -eq 1 -and $hwnd -ne 0 -and
            [long]$after[0].MainWindowHandle -eq $hwnd -and $before -notcontains $after[0].Id) {
            $ownedInstance = $true
        }
    } catch { $ownedInstance = $false }
    $presentations = $app.Presentations
    $presentation = $presentations.Open($InputPath, -1, 0, 0)
    $slides = $presentation.Slides
    $pageSetup = $presentation.PageSetup
    $slideWidth = [double]$pageSetup.SlideWidth
    $slideHeight = [double]$pageSetup.SlideHeight
    $qa.slideCount = [int]$slides.Count
    $qa.auditComplete = $true
    for ($i = 1; $i -le $qa.slideCount; $i++) {
        $slide = $null
        $shapes = $null
        $record = [ordered]@{
            slide = $i
            shapeCount = 0
            nativeShapeCount = 0
            nativeTextCount = 0
            imageCount = 0
            chartCount = 0
            inspectionFailures = 0
            textBounds = (New-Object 'System.Collections.Generic.List[object]')
            textOverflows = (New-Object 'System.Collections.Generic.List[object]')
            shapeOverflows = (New-Object 'System.Collections.Generic.List[object]')
        }
        try {
            $slide = $slides.Item($i)
            $shapes = $slide.Shapes
            $record.shapeCount = [int]$shapes.Count
            for ($j = 1; $j -le $record.shapeCount; $j++) {
                $shape = $null
                try {
                    $shape = $shapes.Item($j)
                    Inspect-Shape $shape $record ([string]$j) $slideWidth $slideHeight
                } catch {
                    $record.inspectionFailures++
                } finally {
                    Release-ComObject $shape
                }
            }
            $record.textIntersections = New-Object 'System.Collections.Generic.List[object]'
            for ($a = 0; $a -lt $record.textBounds.Count; $a++) {
                for ($b = $a + 1; $b -lt $record.textBounds.Count; $b++) {
                    $ta = $record.textBounds[$a]; $tb = $record.textBounds[$b]
                    $iw = [Math]::Min($ta.boundLeft + $ta.boundWidth, $tb.boundLeft + $tb.boundWidth) - [Math]::Max($ta.boundLeft, $tb.boundLeft)
                    $ih = [Math]::Min($ta.boundTop + $ta.boundHeight, $tb.boundTop + $tb.boundHeight) - [Math]::Max($ta.boundTop, $tb.boundTop)
                    if ($iw -gt 1.25 -and $ih -gt 1.25) {
                        [void]$record.textIntersections.Add([ordered]@{ first=$ta.shape; second=$tb.shape; text1=$ta.text; text2=$tb.text; width=(Round-Point $iw); height=(Round-Point $ih) })
                    }
                }
            }
            $imageName = 'slide-{0:D2}.png' -f $i
            try {
                $slide.Export([IO.Path]::Combine($OutputDir, $imageName), 'PNG', 1600, 900)
                if ([IO.File]::Exists([IO.Path]::Combine($OutputDir, $imageName))) {
                    [void]$qa.imageFiles.Add($imageName)
                } else { throw 'PNG missing' }
            } catch {
                [void]$qa.warnings.Add(('第 {0} 页 PNG 导出失败；可编辑 PPTX 已保留。' -f $i))
            }
        } catch {
            $record.inspectionFailures++
            [void]$qa.warnings.Add(('第 {0} 页读取/导出失败；未修改原始 PPTX。' -f $i))
        } finally {
            if ($record.inspectionFailures -gt 0) {
                $qa.auditComplete = $false
                [void]$qa.warnings.Add(('第 {0} 页有 {1} 个对象未能完成 TextFrame2 审计。' -f $i, $record.inspectionFailures))
            }
            $qa.nativeShapeCount += $record.nativeShapeCount
            $qa.nativeTextCount += $record.nativeTextCount
            $qa.imageCount += $record.imageCount
            [void]$qa.slides.Add($record)
            Release-ComObject $shapes
            Release-ComObject $slide
        }
    }
    if (-not $SkipPdf) { try {
        $presentation.SaveAs([IO.Path]::Combine($OutputDir, 'preview.pdf'), 32)
        $qa.pdfExported = [IO.File]::Exists([IO.Path]::Combine($OutputDir, 'preview.pdf'))
        if (-not $qa.pdfExported) { throw 'PDF missing' }
    } catch {
        [void]$qa.warnings.Add('PowerPoint SaveAs PDF（格式 32）失败，PPTX 和已导出的 PNG 仍可使用。')
    }
    }
    $qa.completed = $true
} catch {
    $exitCode = 1
    [void]$qa.warnings.Add('PowerPoint COM 无法打开或完成导出；已保留原始可编辑 PPTX，不返回本机错误详情。')
} finally {
    Release-ComObject $pageSetup
    Release-ComObject $slides
    if ($null -ne $presentation) {
        try {
            $presentation.Saved = -1
            $presentation.Close()
            $closed = $true
        } catch {
            [void]$qa.warnings.Add('本次打开的 presentation 未能正常关闭；未强制终止 PowerPoint。')
        }
        Release-ComObject $presentation
    } else { $closed = $true }
    # Never quit an existing instance, or any instance containing another deck.
    if ($ownedInstance -and $closed -and $null -ne $presentations) {
        try {
            if ($presentations.Count -eq 0) { $app.Quit() }
        } catch { }
    }
    Release-ComObject $presentations
    Release-ComObject $app
    try {
        $json = ConvertTo-Json -InputObject $qa -Depth 12
        $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
        [IO.File]::WriteAllText([IO.Path]::Combine($OutputDir, 'qa.json'), $json, $utf8)
    } catch {
        $exitCode = 1
        [Console]::Error.WriteLine('无法写入输出目录中的 qa.json。')
    }
}
exit $exitCode
