package com.dvesiz.chronos;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 开机、换时区、改时间、升级后，重建全部提醒，并刷新桌面小组件。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        AlarmScheduler.rebuildFromStore(context);
        ChronosWidgetProvider.refresh(context);
    }
}
