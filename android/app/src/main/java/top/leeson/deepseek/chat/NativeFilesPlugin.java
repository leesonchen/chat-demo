package top.leeson.deepseek.chat;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

@CapacitorPlugin(name = "NativeFiles")
public class NativeFilesPlugin extends Plugin {
    private File fileFor(PluginCall call) throws IOException {
        String id = call.getString("id", "");
        String name = call.getString("name", "");
        if (!id.matches("[0-9a-f-]{36}") || name.isEmpty() || name.equals(".") || name.equals("..")
            || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('\0') >= 0) {
            throw new IOException("Invalid attachment path");
        }
        return new File(getContext().getCacheDir(), "attachments/" + id + "/" + name);
    }

    @PluginMethod
    public void append(PluginCall call) {
        try {
            File file = fileFor(call);
            File directory = file.getParentFile();
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create cache folder");
            String chunk = call.getString("data", "");
            if (chunk.length() > 400_000) throw new IOException("Attachment chunk exceeds the size limit");
            try (FileOutputStream output = new FileOutputStream(file, true)) {
                output.write(Base64.decode(chunk, Base64.DEFAULT));
            }
            call.resolve();
        } catch (IOException | IllegalArgumentException error) {
            call.reject("Unable to write attachment", error);
        }
    }

    @PluginMethod
    public void discard(PluginCall call) {
        try {
            remove(fileFor(call));
            call.resolve();
        } catch (IOException error) {
            call.reject("Unable to clean up attachment", error);
        }
    }

    @PluginMethod
    public void save(PluginCall call) {
        try {
            File file = fileFor(call);
            if (!file.isFile()) throw new IOException("Attachment missing");
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(call.getString("type", "application/octet-stream"))
                .putExtra(Intent.EXTRA_TITLE, file.getName());
            getActivity().runOnUiThread(() -> {
                try {
                    startActivityForResult(call, intent, "saveResult");
                } catch (ActivityNotFoundException error) {
                    remove(file);
                    call.reject("No Android file picker is available", error);
                }
            });
        } catch (IOException error) {
            call.reject("Unable to save attachment", error);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        getBridge().execute(() -> {
            try {
                File file = fileFor(call);
                try {
                    Uri target = result.getData() == null ? null : result.getData().getData();
                    if (result.getResultCode() == Activity.RESULT_OK && target != null) {
                        try (FileInputStream input = new FileInputStream(file);
                             OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
                            if (output == null) throw new IOException("No destination stream");
                            byte[] buffer = new byte[64 * 1024];
                            int length;
                            while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
                        }
                    }
                } finally {
                    remove(file);
                }
                call.resolve();
            } catch (IOException | SecurityException error) {
                call.reject("Unable to save attachment", error);
            }
        });
    }

    @PluginMethod
    public void open(PluginCall call) {
        try {
            File file = fileFor(call);
            if (!file.isFile()) throw new IOException("Attachment missing");
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, call.getString("type", "application/octet-stream"))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().runOnUiThread(() -> {
                try {
                    getActivity().startActivity(intent);
                    call.resolve();
                } catch (ActivityNotFoundException error) {
                    save(call);
                }
            });
        } catch (IOException | IllegalArgumentException error) {
            call.reject("Unable to open attachment", error);
        }
    }

    private static void remove(File file) {
        file.delete();
        file.getParentFile().delete();
    }
}
