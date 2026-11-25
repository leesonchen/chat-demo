package top.leeson.deepseek.chat;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.tencent.mm.opensdk.modelmsg.SendAuth;
import com.tencent.mm.opensdk.openapi.IWXAPI;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

public class WechatAuthActivity extends Activity {
    private static String activeAppId;
    private static String activeState;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable cancel = () -> complete("cancelled", null);
    private boolean returnedFromWechat;
    private String state;

    @Override
    protected void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        String appId = getIntent().getStringExtra("appId");
        state = getIntent().getStringExtra("state");
        if (appId == null || state == null) {
            finish();
            return;
        }
        activeAppId = appId;
        activeState = state;
        if (savedState != null) {
            returnedFromWechat = savedState.getBoolean("returnedFromWechat");
            return;
        }

        IWXAPI api = WXAPIFactory.createWXAPI(this, appId, true);
        if (!api.isWXAppInstalled()) {
            complete("not_installed", null);
            return;
        }
        SendAuth.Req request = new SendAuth.Req();
        request.scope = "snsapi_userinfo";
        request.state = state;
        if (!api.registerApp(appId) || !api.sendReq(request)) {
            complete("failed", null);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (state == null || !state.equals(intent.getStringExtra("state"))) return;
        complete(intent.getStringExtra("status"), intent.getStringExtra("code"));
    }

    @Override
    protected void onPause() {
        returnedFromWechat = true;
        handler.removeCallbacks(cancel);
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (returnedFromWechat) {
            // If WeChat was dismissed without a callback, restore the login button.
            handler.postDelayed(cancel, 750);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("returnedFromWechat", true);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(cancel);
        clearPendingAuthorization();
        super.onDestroy();
    }

    private void complete(String status, String code) {
        handler.removeCallbacks(cancel);
        clearPendingAuthorization();
        setResult(RESULT_OK, new Intent().putExtra("status", status).putExtra("code", code));
        finish();
    }

    private void clearPendingAuthorization() {
        if (state != null && state.equals(activeState)) {
            activeAppId = null;
            activeState = null;
        }
    }

    public static String getActiveAppId() {
        return activeAppId;
    }

    public static boolean isPending(String state) {
        return state != null && state.equals(activeState);
    }
}
