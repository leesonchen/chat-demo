package top.leeson.deepseek.chat;

import android.annotation.SuppressLint;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.io.IOException;
import java.io.OutputStream;
import org.json.JSONArray;
import org.json.JSONException;

public class WechatLoginActivity extends AppCompatActivity {
    private static final String QR_PREFIX = "data:image/gif;base64,";
    private WebView webView;
    private byte[] pendingQr;

    private final ActivityResultLauncher<Intent> saveDocument = registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(), result -> {
            byte[] image = pendingQr;
            pendingQr = null;
            Uri target = result.getData() == null ? null : result.getData().getData();
            if (result.getResultCode() == RESULT_OK && target != null && image != null) {
                try {
                    writeQr(target, image);
                    notifyUser(R.string.wechat_qr_saved);
                } catch (IOException | SecurityException error) {
                    notifyUser(R.string.file_save_error);
                }
            }
        }
    );

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Uri initial = getIntent().getData();
        if (!MainActivity.isHttpsHost(initial, MainActivity.AUTH_HOST) || !"/authorize".equals(initial.getPath())) {
            finish();
            return;
        }
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        ViewCompat.setOnApplyWindowInsetsListener(layout, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        LinearLayout actions = new LinearLayout(this);
        Button back = new Button(this);
        back.setText(R.string.close_login);
        back.setOnClickListener(view -> finish());
        actions.addView(back);
        Button save = new Button(this);
        save.setText(R.string.save_wechat_qr);
        save.setOnClickListener(view -> saveQr());
        actions.addView(save);
        layout.addView(actions);
        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (MainActivity.isHttpsHost(url, MainActivity.AUTH_HOST)) return false;
                if (request.isForMainFrame() && MainActivity.isHttpsHost(url, MainActivity.APP_HOST)) {
                    if ("/api/auth/wechat/callback".equals(url.getPath())) return false;
                    if ("/".equals(url.getPath())) {
                        String result = url.getQueryParameter("wechat_login");
                        if ("ok".equals(result) || "failed".equals(result)) {
                            CookieManager.getInstance().flush();
                            setResult(RESULT_OK, new Intent().putExtra("loginResult", result));
                            finish();
                        }
                    }
                }
                return true;
            }
        });
        layout.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(layout);
        webView.loadUrl(initial.toString());
    }

    private void saveQr() {
        String page = webView.getUrl();
        if (page == null || !MainActivity.isHttpsHost(Uri.parse(page), MainActivity.AUTH_HOST)) return;
        webView.evaluateJavascript("document.querySelector('#login img')?.getAttribute('src') || ''", value -> {
            try {
                String source = new JSONArray("[" + value + "]").optString(0);
                if (!source.startsWith(QR_PREFIX) || source.length() > 1_000_000) {
                    notifyUser(R.string.wechat_qr_pending);
                    return;
                }
                byte[] image = Base64.decode(source.substring(QR_PREFIX.length()), Base64.DEFAULT);
                if (Build.VERSION.SDK_INT >= 29) {
                    saveToPictures(image);
                } else {
                    pendingQr = image;
                    saveDocument.launch(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("image/gif").putExtra(Intent.EXTRA_TITLE, "DeepSeek WeChat Login.gif"));
                }
            } catch (JSONException | IllegalArgumentException | IOException | SecurityException error) {
                notifyUser(R.string.file_save_error);
            }
        });
    }

    private void saveToPictures(byte[] image) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, "DeepSeek WeChat Login.gif");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/gif");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/DeepSeek");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri target = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (target == null) throw new IOException("Image destination unavailable");
        try {
            writeQr(target, image);
            values.clear();
            values.put(MediaStore.Images.Media.IS_PENDING, 0);
            getContentResolver().update(target, values, null, null);
        } catch (IOException | SecurityException error) {
            getContentResolver().delete(target, null, null);
            throw error;
        }
        notifyUser(R.string.wechat_qr_saved);
    }

    private void writeQr(Uri target, byte[] image) throws IOException {
        try (OutputStream stream = getContentResolver().openOutputStream(target)) {
            if (stream == null) throw new IOException("Image destination unavailable");
            stream.write(image);
        }
    }

    private void notifyUser(int message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            ((LinearLayout) webView.getParent()).removeView(webView);
            webView.destroy();
        }
        super.onDestroy();
    }
}
