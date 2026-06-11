param(
    [string]$Action,
    [string]$ChildHWnd = "0",
    [string]$ParentHWnd = "0",
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 0,
    [int]$Height = 0,
    [int]$AppPid = 0,
    [string]$ExePath = ""
)

$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;

public class Win32 {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    public const int GWL_STYLE = -16;
    public const int WS_CAPTION = 0x00C00000;
    public const int WS_THICKFRAME = 0x00040000;
    public const int WS_MINIMIZEBOX = 0x00020000;
    public const int WS_MAXIMIZEBOX = 0x00010000;
    public const int WS_SYSMENU = 0x00080000;
    public const int WS_CHILD = 0x40000000;

    public const int SW_HIDE = 0;
    public const int SW_SHOW = 5;

    // 获取窗口真实的 PID
    public static int GetWindowPid(IntPtr hWnd) {
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        return (int)pid;
    }

    // 获取所有当前已存在的该映像名的顶级可见窗口句柄
    public static long[] GetVisibleWindowsByName(string exeName) {
        List<long> hwnds = new List<long>();
        if (string.IsNullOrEmpty(exeName)) return hwnds.ToArray();

        EnumWindows((IntPtr hWnd, IntPtr lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetParent(hWnd) != IntPtr.Zero) return true;

            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);

            try {
                using (Process p = Process.GetProcessById((int)pid)) {
                    if (p.ProcessName.Equals(exeName, StringComparison.OrdinalIgnoreCase)) {
                        hwnds.Add(hWnd.ToInt64());
                    }
                }
            } catch {}
            return true;
        }, IntPtr.Zero);

        return hwnds.ToArray();
    }

    // 双阶段精确查找：首选 PID 树匹配，次选映像名匹配（过滤已存在句柄）
    public static IntPtr FindVisibleWindow(int[] pids, string exeName, long[] excludeHwnds) {
        IntPtr bestHwnd = IntPtr.Zero;
        List<int> pidList = new List<int>(pids);
        List<long> excludeList = new List<long>(excludeHwnds);

        // 阶段一：首选匹配新进程树中产生的顶级可见窗口 (100% 准确，无论标题是否存在)
        if (pidList.Count > 0) {
            EnumWindows((IntPtr hWnd, IntPtr lParam) => {
                if (!IsWindowVisible(hWnd)) return true;
                if (GetParent(hWnd) != IntPtr.Zero) return true;

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);

                if (pidList.Contains((int)pid)) {
                    bestHwnd = hWnd;
                    return false; // 找到，中止 Enum 遍历
                }
                return true;
            }, IntPtr.Zero);
        }

        // 阶段二：降级匹配具有相同映像名称的新生可见窗口 (排除先前记录 of 旧窗口)
        if (bestHwnd == IntPtr.Zero && !string.IsNullOrEmpty(exeName)) {
            EnumWindows((IntPtr hWnd, IntPtr lParam) => {
                if (!IsWindowVisible(hWnd)) return true;
                if (GetParent(hWnd) != IntPtr.Zero) return true;
                if (excludeList.Contains(hWnd.ToInt64())) return true; // 排除已存在的旧窗口

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);

                try {
                    using (Process p = Process.GetProcessById((int)pid)) {
                        if (p.ProcessName.Equals(exeName, StringComparison.OrdinalIgnoreCase)) {
                            bestHwnd = hWnd;
                            return false; // 找到新窗口，中止 Enum 遍历
                        }
                    }
                } catch {}
                return true;
            }, IntPtr.Zero);
        }

        return bestHwnd;
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'Win32').Type) {
    Add-Type -TypeDefinition $code
}

# Convert string HWNDs to IntPtr
$childHwndPtr = [IntPtr]::Zero
if ($ChildHWnd -and $ChildHWnd -ne "0") {
    $childHwndPtr = [IntPtr][long]$ChildHWnd
}
$parentHwndPtr = [IntPtr]::Zero
if ($ParentHWnd -and $ParentHWnd -ne "0") {
    $parentHwndPtr = [IntPtr][long]$ParentHWnd
}

if ($Action -eq "bind") {
    # 如果未提供 ChildHWnd，则在进程树中或同名进程中进行窗口查找
    if ($childHwndPtr -eq [IntPtr]::Zero) {
        $exeName = ""
        if ($ExePath) {
            $exeName = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
        }
        
        # 记录轮询前已存在的同名旧窗口句柄，用作后续排除
        $excludeHwnds = @()
        if ($exeName) {
            $excludeHwnds = [Win32]::GetVisibleWindowsByName($exeName)
        }
        
        $foundHwnd = [IntPtr]::Zero
        # 轮询 30 次（每次 300ms，共 9 秒）以等待窗口创建就绪
        for ($i = 0; $i -lt 30; $i++) {
            $pids = @()
            if ($AppPid -gt 0) {
                $pids += $AppPid
                
                # 获取子孙进程
                $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $AppPid" -ErrorAction SilentlyContinue
                if (-not $children) {
                    $children = Get-WmiObject Win32_Process -Filter "ParentProcessId = $AppPid" -ErrorAction SilentlyContinue
                }
                if ($children) {
                    foreach ($c in $children) {
                        $pids += $c.ProcessId
                        # 获取孙子进程
                        $grands = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($c.ProcessId)" -ErrorAction SilentlyContinue
                        if ($grands) {
                            foreach ($g in $grands) {
                                $pids += $g.ProcessId
                            }
                        }
                    }
                }
            }
            
            # 调用 C# 方法定位最符合要求的顶级可见 UI 窗口
            $hwnd = [Win32]::FindVisibleWindow([int[]]$pids, $exeName, [long[]]$excludeHwnds)
            if ($hwnd -ne [IntPtr]::Zero) {
                $foundHwnd = $hwnd
                break
            }
            
            Start-Sleep -Milliseconds 300
        }
        
        if ($foundHwnd -eq [IntPtr]::Zero) {
            Write-Error "Cannot find visible UI window for Pid: $AppPid, ExePath: $ExePath in 9 seconds."
            exit 1
        }
        
        $childHwndPtr = $foundHwnd
    }

    # 在执行 SetParent 之前，先获取真实 PID 并输出，防止窗口状态变化导致获取失败
    $winPid = [Win32]::GetWindowPid($childHwndPtr)
    Write-Output "BoundPid:$winPid"

    # 执行 SetParent 绑定，并将返回值输出屏蔽 (Out-Null)
    [Win32]::SetParent($childHwndPtr, $parentHwndPtr) | Out-Null
    
    # 裁剪窗口样式，去掉标题栏、边框等，使之融合进 HTML 视口，将返回值输出屏蔽 (Out-Null)
    $style = [Win32]::GetWindowLong($childHwndPtr, [Win32]::GWL_STYLE)
    $style = $style -band -bnot [Win32]::WS_CAPTION
    $style = $style -band -bnot [Win32]::WS_THICKFRAME
    $style = $style -band -bnot [Win32]::WS_MINIMIZEBOX
    $style = $style -band -bnot [Win32]::WS_MAXIMIZEBOX
    $style = $style -band -bnot [Win32]::WS_SYSMENU
    $style = $style -bor [Win32]::WS_CHILD
    
    [Win32]::SetWindowLong($childHwndPtr, [Win32]::GWL_STYLE, $style) | Out-Null
    
    # 移动子窗口并显示，并将返回值输出屏蔽 (Out-Null)
    [Win32]::MoveWindow($childHwndPtr, $X, $Y, $Width, $Height, $true) | Out-Null
    [Win32]::ShowWindow($childHwndPtr, [Win32]::SW_SHOW) | Out-Null
    
    # 输出成功找到的窗口句柄，供主进程使用
    Write-Output "BoundHWnd:$($childHwndPtr.ToInt64())"
} elseif ($Action -eq "resize") {
    [Win32]::MoveWindow($childHwndPtr, $X, $Y, $Width, $Height, $true) | Out-Null
} elseif ($Action -eq "show") {
    [Win32]::ShowWindow($childHwndPtr, [Win32]::SW_SHOW) | Out-Null
} elseif ($Action -eq "hide") {
    [Win32]::ShowWindow($childHwndPtr, [Win32]::SW_HIDE) | Out-Null
}
