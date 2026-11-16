param(
  [Parameter(Mandatory = $true)][string]$HeartbeatFile,
  [double]$HeartbeatTimeoutSec = 15,
  [double]$MaxHours = 3
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$source = @'
using System;
using System.Runtime.InteropServices;

namespace GanciKiosk
{
    public static class Hook
    {
        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_KEYUP = 0x0101;
        const int WM_SYSKEYDOWN = 0x0104;
        const int WM_SYSKEYUP = 0x0105;

        const int VK_CONTROL = 0x11;
        const int VK_MENU = 0x12;
        const int VK_SHIFT = 0x10;
        const int VK_ESCAPE = 0x1B;
        const int VK_TAB = 0x09;
        const int VK_F4 = 0x73;
        const int VK_SPACE = 0x20;
        const int VK_LWIN = 0x5B;
        const int VK_RWIN = 0x5C;

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        static extern short GetAsyncKeyState(int vKey);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        static extern IntPtr GetModuleHandle(string lpModuleName);

        static HookProc proc;
        static IntPtr handle = IntPtr.Zero;

        public static volatile bool EscapeRequested;
        public static long Blocked;

        public static void Install()
        {
            proc = new HookProc(OnKey);
            handle = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(null), 0);
            if (handle == IntPtr.Zero)
                throw new InvalidOperationException("SetWindowsHookEx failed, win32 error " + Marshal.GetLastWin32Error());
        }

        public static void Uninstall()
        {
            if (handle != IntPtr.Zero)
            {
                UnhookWindowsHookEx(handle);
                handle = IntPtr.Zero;
            }
        }

        static bool Down(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        static IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                uint vk = info.vkCode;
                int msg = (int)wParam;
                bool press = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN || msg == WM_KEYUP || msg == WM_SYSKEYUP;

                if (press)
                {
                    bool ctrl = Down(VK_CONTROL);
                    bool alt = Down(VK_MENU);

                    // Escape hatch is detected here, not in the app: if Electron is dead the
                    // user still gets out. Returning Zero swallows the combo itself.
                    if (vk == VK_ESCAPE && ctrl && alt)
                    {
                        EscapeRequested = true;
                        return IntPtr.Zero;
                    }
                    if (vk == VK_LWIN || vk == VK_RWIN) { Blocked++; return (IntPtr)1; }
                    if (alt && (vk == VK_TAB || vk == VK_F4 || vk == VK_SPACE)) { Blocked++; return (IntPtr)1; }
                    if (ctrl && vk == VK_ESCAPE) { Blocked++; return (IntPtr)1; }
                }
            }
            return CallNextHookEx(handle, nCode, wParam, lParam);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

if (-not (Test-Path $HeartbeatFile)) {
    Set-Content -Path $HeartbeatFile -Value 'init' -Encoding ASCII
}

[GanciKiosk.Hook]::Install()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

$start = Get-Date
$code = 0
try {
    while ($true) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 150

        if ([GanciKiosk.Hook]::EscapeRequested) { $code = 7; break }

        if (-not (Test-Path $HeartbeatFile)) { $code = 8; break }
        $age = ((Get-Date) - (Get-Item $HeartbeatFile).LastWriteTime).TotalSeconds
        if ($age -gt $HeartbeatTimeoutSec) { $code = 8; break }

        if (((Get-Date) - $start).TotalHours -gt $MaxHours) { $code = 9; break }
    }
} catch {
    $code = 6
} finally {
    [GanciKiosk.Hook]::Uninstall()
    [System.Windows.Forms.Application]::DoEvents()
    [Console]::Out.WriteLine(('BLOCKED=' + [GanciKiosk.Hook]::Blocked))
    [Console]::Out.Flush()
}

exit $code
