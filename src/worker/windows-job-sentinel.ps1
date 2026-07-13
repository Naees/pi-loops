param(
  [Parameter(Mandatory = $true)][int]$TargetProcessId,
  [Parameter(Mandatory = $true)][long]$AbsoluteDeadlineMs,
  [string]$StatusPath = ""
)

$ErrorActionPreference = "Stop"

$nativeSource = @"
using System;
using System.Runtime.InteropServices;

public static class PiLoopsJobObject
{
    public const uint PROCESS_TERMINATE = 0x0001;
    public const uint PROCESS_SET_QUOTA = 0x0100;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    public const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
}
"@

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

$job = [IntPtr]::Zero
$target = [IntPtr]::Zero
$infoPointer = [IntPtr]::Zero
Write-Status "starting"
try {
  Add-Type -TypeDefinition $nativeSource
  $job = [PiLoopsJobObject]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

  $info = New-Object -TypeName 'PiLoopsJobObject+JOBOBJECT_EXTENDED_LIMIT_INFORMATION'
  $basicLimits = New-Object -TypeName 'PiLoopsJobObject+JOBOBJECT_BASIC_LIMIT_INFORMATION'
  $basicLimits.LimitFlags = [PiLoopsJobObject]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  $info.BasicLimitInformation = $basicLimits
  $infoLength = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $infoPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($infoLength)
  [Runtime.InteropServices.Marshal]::StructureToPtr($info, $infoPointer, $false)
  if (-not [PiLoopsJobObject]::SetInformationJobObject($job, [PiLoopsJobObject]::JobObjectExtendedLimitInformation, $infoPointer, $infoLength)) {
    throw "SetInformationJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  $access = [PiLoopsJobObject]::PROCESS_TERMINATE -bor [PiLoopsJobObject]::PROCESS_SET_QUOTA
  $target = [PiLoopsJobObject]::OpenProcess($access, $false, $TargetProcessId)
  if ($target -eq [IntPtr]::Zero) { throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  if (-not [PiLoopsJobObject]::AssignProcessToJobObject($job, $target)) {
    throw "AssignProcessToJobObject failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  [void][PiLoopsJobObject]::CloseHandle($target)
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
  if ($target -ne [IntPtr]::Zero) { [void][PiLoopsJobObject]::CloseHandle($target) }
  if ($infoPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($infoPointer) }
  if ($job -ne [IntPtr]::Zero) { [void][PiLoopsJobObject]::CloseHandle($job) }
}
