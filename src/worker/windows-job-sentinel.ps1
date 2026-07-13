param(
  [Parameter(Mandatory = $true)][int]$TargetProcessId,
  [Parameter(Mandatory = $true)][long]$AbsoluteDeadlineMs,
  [string]$StatusPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Status([string]$Phase, [string]$Detail = "") {
  if ($StatusPath -eq "") { return }
  @{
    phase = $Phase
    detail = $Detail
    sentinelPid = $PID
    targetPid = $TargetProcessId
    absoluteDeadlineMs = $AbsoluteDeadlineMs
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $StatusPath -Encoding UTF8
}

function New-NativeDelegateType([Type]$ReturnType, [Type[]]$ParameterTypes) {
  $assemblyName = [Reflection.AssemblyName]::new("PiLoopsNative$([Guid]::NewGuid().ToString('N'))")
  $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule("Native")
  $type = $module.DefineType(
    "Delegate$([Guid]::NewGuid().ToString('N'))",
    [Reflection.TypeAttributes]::Class -bor [Reflection.TypeAttributes]::Public -bor [Reflection.TypeAttributes]::Sealed,
    [MulticastDelegate]
  )
  $constructor = $type.DefineConstructor(
    [Reflection.MethodAttributes]::RTSpecialName -bor [Reflection.MethodAttributes]::HideBySig -bor [Reflection.MethodAttributes]::Public,
    [Reflection.CallingConventions]::Standard,
    [Type[]]@([object], [IntPtr])
  )
  $constructor.SetImplementationFlags([Reflection.MethodImplAttributes]::Runtime -bor [Reflection.MethodImplAttributes]::Managed)
  $invoke = $type.DefineMethod(
    "Invoke",
    [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::HideBySig -bor [Reflection.MethodAttributes]::NewSlot -bor [Reflection.MethodAttributes]::Virtual,
    $ReturnType,
    $ParameterTypes
  )
  $invoke.SetImplementationFlags([Reflection.MethodImplAttributes]::Runtime -bor [Reflection.MethodImplAttributes]::Managed)
  return $type.CreateType()
}

function Get-NativeFunction([IntPtr]$Library, [string]$Name, [Type]$ReturnType, [Type[]]$ParameterTypes) {
  $address = [Runtime.InteropServices.NativeLibrary]::GetExport($Library, $Name)
  $delegateType = New-NativeDelegateType $ReturnType $ParameterTypes
  return [Runtime.InteropServices.Marshal]::GetDelegateForFunctionPointer($address, $delegateType)
}

$job = [IntPtr]::Zero
$target = [IntPtr]::Zero
$infoPointer = [IntPtr]::Zero
Write-Status "starting"
try {
  if ([IntPtr]::Size -ne 8) { throw "The Windows job sentinel requires a 64-bit process" }
  $kernel32 = [Runtime.InteropServices.NativeLibrary]::Load("kernel32.dll")
  $createJob = Get-NativeFunction $kernel32 "CreateJobObjectW" ([IntPtr]) ([Type[]]@([IntPtr], [IntPtr]))
  $setJob = Get-NativeFunction $kernel32 "SetInformationJobObject" ([bool]) ([Type[]]@([IntPtr], [int], [IntPtr], [uint32]))
  $openProcess = Get-NativeFunction $kernel32 "OpenProcess" ([IntPtr]) ([Type[]]@([uint32], [bool], [int]))
  $assignProcess = Get-NativeFunction $kernel32 "AssignProcessToJobObject" ([bool]) ([Type[]]@([IntPtr], [IntPtr]))
  $closeHandle = Get-NativeFunction $kernel32 "CloseHandle" ([bool]) ([Type[]]@([IntPtr]))

  $job = $createJob.Invoke([IntPtr]::Zero, [IntPtr]::Zero)
  if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed" }

  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64. LimitFlags is
  # the uint32 at byte offset 16 in its BASIC_LIMIT_INFORMATION prefix.
  $infoLength = 144
  $infoPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($infoLength)
  for ($offset = 0; $offset -lt $infoLength; $offset += 4) {
    [Runtime.InteropServices.Marshal]::WriteInt32($infoPointer, $offset, 0)
  }
  [Runtime.InteropServices.Marshal]::WriteInt32($infoPointer, 16, 0x00002000)
  if (-not $setJob.Invoke($job, 9, $infoPointer, $infoLength)) { throw "SetInformationJobObject failed" }

  $target = $openProcess.Invoke(0x00000101, $false, $TargetProcessId)
  if ($target -eq [IntPtr]::Zero) { throw "OpenProcess failed" }
  if (-not $assignProcess.Invoke($job, $target)) { throw "AssignProcessToJobObject failed" }
  [void]$closeHandle.Invoke($target)
  $target = [IntPtr]::Zero

  Write-Status "ready"
  [Console]::Out.WriteLine("PI_LOOPS_SENTINEL_READY")
  [Console]::Out.Flush()

  while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $AbsoluteDeadlineMs) {
    $remaining = $AbsoluteDeadlineMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min(250, $remaining)))
  }
  Write-Status "closing-job"
}
catch {
  Write-Status "failed" $_.Exception.Message
  throw
}
finally {
  if ($target -ne [IntPtr]::Zero -and $null -ne $closeHandle) { [void]$closeHandle.Invoke($target) }
  if ($infoPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($infoPointer) }
  if ($job -ne [IntPtr]::Zero -and $null -ne $closeHandle) { [void]$closeHandle.Invoke($job) }
}
