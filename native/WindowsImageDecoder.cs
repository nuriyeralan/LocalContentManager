using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

internal static class WindowsImageDecoder
{
    private const int SampleSize = 96;
    private const long MaxPixels = 100000000;

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) throw new ArgumentException("A parent process ID is required.");
            using (Process parent = Process.GetProcessById(int.Parse(args[0], CultureInfo.InvariantCulture)))
            {
                parent.Exited += delegate { Process.GetCurrentProcess().Kill(); };
                parent.EnableRaisingEvents = true;
                if (parent.HasExited) return 1;
                using (BinaryWriter output = new BinaryWriter(Console.OpenStandardOutput()))
                {
                    try
                    {
                        string request = Console.ReadLine();
                        if (string.IsNullOrEmpty(request)) throw new InvalidDataException("An image path is required.");
                        string filePath = Encoding.UTF8.GetString(Convert.FromBase64String(request));
                        WriteImage(output, filePath);
                    }
                    catch (Exception error)
                    {
                        WriteError(output, error);
                    }
                    output.Flush();
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static int Orientation(BitmapFrame frame)
    {
        BitmapMetadata metadata = frame.Metadata as BitmapMetadata;
        if (metadata == null) return 1;
        foreach (string query in new[] { "/app1/ifd/{ushort=274}", "/ifd/{ushort=274}" })
        {
            if (!metadata.ContainsQuery(query)) continue;
            int orientation = Convert.ToInt32(metadata.GetQuery(query), CultureInfo.InvariantCulture);
            if (orientation < 1 || orientation > 8) throw new InvalidDataException("Invalid EXIF orientation.");
            return orientation;
        }
        return 1;
    }

    private static void WriteImage(BinaryWriter output, string filePath)
    {
        using (FileStream input = new FileStream(filePath, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete))
        {
            BitmapDecoder decoder = BitmapDecoder.Create(input,
                BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.None);
            if (decoder.Frames.Count == 0) throw new InvalidDataException("The image has no decodable frames.");
            BitmapFrame frame = decoder.Frames[0];
            if (frame.PixelWidth <= 0 || frame.PixelHeight <= 0 ||
                (long)frame.PixelWidth * frame.PixelHeight > MaxPixels)
            {
                throw new InvalidDataException("The image exceeds the 100-megapixel input limit.");
            }

            BitmapSource source = frame;
            if (frame.ColorContexts != null && frame.ColorContexts.Count > 0)
            {
                source = new ColorConvertedBitmap(source, frame.ColorContexts[0],
                    new ColorContext(PixelFormats.Bgra32), PixelFormats.Bgra32);
            }
            Matrix transform;
            switch (Orientation(frame))
            {
                case 2: transform = new Matrix(-1, 0, 0, 1, 0, 0); break;
                case 3: transform = new Matrix(-1, 0, 0, -1, 0, 0); break;
                case 4: transform = new Matrix(1, 0, 0, -1, 0, 0); break;
                case 5: transform = new Matrix(0, 1, 1, 0, 0, 0); break;
                case 6: transform = new Matrix(0, 1, -1, 0, 0, 0); break;
                case 7: transform = new Matrix(0, -1, -1, 0, 0, 0); break;
                case 8: transform = new Matrix(0, -1, 1, 0, 0, 0); break;
                default: transform = Matrix.Identity; break;
            }
            if (!transform.IsIdentity) source = new TransformedBitmap(source, new MatrixTransform(transform));
            int width = source.PixelWidth;
            int height = source.PixelHeight;

            // Draw the full decoded frame, never the decoder's embedded thumbnail or preview.
            DrawingVisual visual = new DrawingVisual();
            RenderOptions.SetBitmapScalingMode(visual, BitmapScalingMode.Fant);
            using (DrawingContext drawing = visual.RenderOpen())
            {
                Rect bounds = new Rect(0, 0, SampleSize, SampleSize);
                drawing.DrawRectangle(Brushes.White, null, bounds);
                drawing.DrawImage(source, bounds);
            }
            RenderTargetBitmap sample = new RenderTargetBitmap(
                SampleSize, SampleSize, 96, 96, PixelFormats.Pbgra32);
            sample.Render(visual);
            byte[] bgra = new byte[SampleSize * SampleSize * 4];
            sample.CopyPixels(bgra, SampleSize * 4, 0);
            byte[] rgb = new byte[SampleSize * SampleSize * 3];
            for (int pixel = 0; pixel < SampleSize * SampleSize; pixel++)
            {
                rgb[pixel * 3] = bgra[pixel * 4 + 2];
                rgb[pixel * 3 + 1] = bgra[pixel * 4 + 1];
                rgb[pixel * 3 + 2] = bgra[pixel * 4];
            }
            WriteHeader(output, 0, width, height, rgb.Length);
            output.Write(rgb);
        }
    }

    private static void WriteError(BinaryWriter output, Exception error)
    {
        StringBuilder message = new StringBuilder();
        int hresult = error.HResult;
        for (Exception current = error; current != null; current = current.InnerException)
        {
            if (message.Length > 0) message.Append(" ");
            message.Append(current.Message);
            hresult = current.HResult;
        }
        byte[] details = Encoding.UTF8.GetBytes(message.ToString());
        int length = Math.Min(details.Length, 4096);
        WriteHeader(output, 1, hresult, 0, length);
        output.Write(details, 0, length);
    }

    private static void WriteHeader(BinaryWriter output, int status, int width, int height, int length)
    {
        output.Write(new byte[] { 76, 67, 87, 49 });
        output.Write(status);
        output.Write(width);
        output.Write(height);
        output.Write(length);
    }
}
