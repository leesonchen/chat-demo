package top.leeson.deepseek.chat.wxapi;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import com.tencent.mm.opensdk.modelbase.BaseReq;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.modelmsg.SendAuth;
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;
import top.leeson.deepseek.chat.WechatAuthActivity;

public class WXEntryActivity extends Activity implements IWXAPIEventHandler {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleCallback(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleCallback(intent);
    }

    private void handleCallback(Intent intent) {
        String appId = WechatAuthActivity.getActiveAppId();
        if (appId != null) {
            WXAPIFactory.createWXAPI(this, appId, true).handleIntent(intent, this);
        }
        finish();
    }

    @Override
    public void onReq(BaseReq request) {}

    @Override
    public void onResp(BaseResp response) {
        if (!(response instanceof SendAuth.Resp)) return;
        SendAuth.Resp auth = (SendAuth.Resp) response;
        if (!WechatAuthActivity.isPending(auth.state)) return;
        String status = "failed";
        if (auth.errCode == BaseResp.ErrCode.ERR_OK && auth.code != null && !auth.code.isEmpty()) {
            status = "ok";
        } else if (auth.errCode == BaseResp.ErrCode.ERR_USER_CANCEL) {
            status = "cancelled";
        }
        startActivity(new Intent(this, WechatAuthActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("state", auth.state)
            .putExtra("status", status)
            .putExtra("code", auth.code));
    }
}
