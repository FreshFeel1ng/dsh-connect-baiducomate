using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Windows.Forms;

internal static class Program
{
    private const int ShimPort = 8790;

    [STAThread]
    private static void Main()
    {
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(directory, "comate-shim.js");

        if (!File.Exists(script))
        {
            Show("找不到 comate-shim.js。\n请把本 exe 放在项目根目录。");
            return;
        }

        if (IsPortOpen("127.0.0.1", ShimPort))
        {
            Show("shim 已经在运行：\nhttp://127.0.0.1:" + ShimPort);
            return;
        }

        string node = FindNode(directory);
        if (node == null)
        {
            Show("未找到 Node.js。\n请先安装 Node.js 20+，并确保 node.exe 在 PATH 中。");
            return;
        }

        // /k keeps the console open after the process exits so startup errors
        // remain readable. The double-quote wrapper is cmd's standard form for
        // a command whose executable path contains spaces.
        string arguments = "/k \"\"" + node + "\" \"" + script + "\"\"";
        var startInfo = new ProcessStartInfo("cmd.exe", arguments)
        {
            WorkingDirectory = directory,
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Normal
        };

        try
        {
            Process.Start(startInfo);
        }
        catch (Exception ex)
        {
            Show("启动失败：\n" + ex.Message);
        }
    }

    private static bool IsPortOpen(string host, int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                IAsyncResult result = client.BeginConnect(host, port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(400)) return false;
                client.EndConnect(result);
                return true;
            }
        }
        catch
        {
            return false;
        }
    }

    private static string FindNode(string directory)
    {
        string local = Path.Combine(directory, "node.exe");
        if (File.Exists(local)) return local;

        string path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (string part in path.Split(';'))
        {
            try
            {
                string candidate = Path.Combine(part.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // Ignore malformed PATH entries.
            }
        }

        string[] candidates = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
            @"D:\Program Files\nodejs\node.exe",
            @"C:\Program Files\nodejs\node.exe"
        };

        foreach (string candidate in candidates)
        {
            if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static void Show(string message)
    {
        MessageBox.Show(message, "Comate Shim", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
