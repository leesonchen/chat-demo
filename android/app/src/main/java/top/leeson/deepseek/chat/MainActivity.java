package top.leeson.deepseek.chat;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;
import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    static final String APP_HOST = "deepseek.leeson.top";
    static final String AUTH_HOST = "auth.leeson.top";
    static final String APP_URL = "https://" + APP_HOST + "/";

    private final ActivityResultLauncher<Intent> login = registerForActivityResult(
        new ActivityResultContracts.StartActivityForResult(), result -> {
            if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                String loginResult = result.getData().getStringExtra("loginResult");
                if ("ok".equals(loginResult) || "failed".equals(loginResult)) {
                    bridge.getWebView().loadUrl(APP_URL + "?wechat_login=" + loginResult);
                }
            }
        }
    );

    static boolean isHttpsHost(Uri url, String host) {
        return url != null && "https".equals(url.getScheme()) && host.equals(url.getHost())
            && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443);
    }

    @Override
    public void onCreate(Bundle state) {
        registerPlugin(NativeFilesPlugin.class);
        registerPlugin(NativeWechatPlugin.class);
        super.onCreate(state);
    }

    @Override
    protected void load() {
        super.load();
        WebView webView = bridge.getWebView();
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setSupportMultipleWindows(false);
        webView.setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (isHttpsHost(request.getOrigin(), APP_HOST)
                    && Arrays.equals(request.getResources(), new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE })) {
                    super.onPermissionRequest(request);
                } else {
                    request.deny();
                }
            }
        });
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String path = url.getEncodedPath();
                if (isHttpsHost(url, APP_HOST) && path != null && path.startsWith("/api/")) {
                    return null;
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!request.isForMainFrame()) return super.shouldOverrideUrlLoading(view, request);
                if (isHttpsHost(url, AUTH_HOST) && "/authorize".equals(url.getPath())) {
                    login.launch(new Intent(MainActivity.this, WechatLoginActivity.class).setData(url));
                    return true;
                }
                if (isHttpsHost(url, APP_HOST) && ("/".equals(url.getPath())
                    || "/android-webview-error.html".equals(url.getPath()))) {
                    return false;
                }
                if ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, url));
                    } catch (ActivityNotFoundException error) {
                        Toast.makeText(MainActivity.this, R.string.browser_unavailable, Toast.LENGTH_SHORT).show();
                    }
                }
                return true;
            }
        });
    }
}
