package top.leeson.deepseek.chat;

import android.app.Activity;
import android.content.Intent;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeWechat")
public class NativeWechatPlugin extends Plugin {
    @PluginMethod
    public void authorize(PluginCall call) {
        String appId = call.getString("appId");
        String state = call.getString("state");
        if (appId == null || !appId.matches("(?i)wx[a-f0-9]{16}")
            || state == null || !state.matches("[A-Za-z0-9_-]{43}")) {
            call.reject("Invalid WeChat authorization request");
            return;
        }
        Intent intent = new Intent(getActivity(), WechatAuthActivity.class)
            .putExtra("appId", appId)
            .putExtra("state", state);
        startActivityForResult(call, intent, "onAuthorizationResult");
    }

    @ActivityCallback
    private void onAuthorizationResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        JSObject response = new JSObject();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            response.put("status", data.getStringExtra("status"));
            response.put("code", data.getStringExtra("code"));
        } else {
            response.put("status", "cancelled");
        }
        call.resolve(response);
    }
}
