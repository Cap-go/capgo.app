package app.capgo.capacitornotifications;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.CommonNotificationBuilder;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.NotificationParams;
import com.google.firebase.messaging.RemoteMessage;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Queue;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "CapgoNotifications",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = CapgoNotificationsPlugin.PUSH_NOTIFICATIONS)
)
public class CapgoNotificationsPlugin extends Plugin {

    static final String PUSH_NOTIFICATIONS = "receive";
    private static final String EVENT_TOKEN_CHANGE = "registration";
    private static final String EVENT_TOKEN_ERROR = "registrationError";
    private static final String PREFS_NAME = "capgo_notifications";
    private static final String INSTALL_ID_KEY = "nativeInstallId";
    private static final String BADGE_KEY = "badge";
    private static final int MAX_PENDING_MESSAGES = 64;
    private static final Object pendingMessagesLock = new Object();
    private static final Queue<RemoteMessage> pendingMessages = new ArrayDeque<>();

    public static Bridge staticBridge = null;
    public NotificationManager notificationManager;
    private NotificationChannelManager notificationChannelManager;
    private SharedPreferences preferences;

    public void load() {
        notificationManager = (NotificationManager) getActivity().getSystemService(Context.NOTIFICATION_SERVICE);
        preferences = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        staticBridge = this.bridge;
        while (true) {
            RemoteMessage pendingMessage;
            synchronized (pendingMessagesLock) {
                pendingMessage = pendingMessages.poll();
            }
            if (pendingMessage == null) {
                break;
            }
            fireNotification(pendingMessage);
        }
        notificationChannelManager = new NotificationChannelManager(getActivity(), notificationManager);
    }

    @Override
    protected void handleOnNewIntent(Intent data) {
        super.handleOnNewIntent(data);
        Bundle bundle = data.getExtras();
        if (bundle != null && bundle.containsKey("google.message_id")) {
            JSObject notificationJson = new JSObject();
            JSObject dataObject = new JSObject();
            for (String key : bundle.keySet()) {
                if (key.equals("google.message_id")) {
                    notificationJson.put("id", bundle.getString(key));
                } else {
                    dataObject.put(key, bundle.get(key));
                }
            }
            notificationJson.put("data", dataObject);
            JSObject actionJson = new JSObject();
            actionJson.put("actionId", "tap");
            actionJson.put("notification", notificationJson);
            notifyListeners("notificationOpened", actionJson, true);
        }
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject permissionsResultJSON = new JSObject();
            permissionsResultJSON.put("receive", "granted");
            call.resolve(permissionsResultJSON);
        } else {
            super.checkPermissions(call);
        }
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(PUSH_NOTIFICATIONS) == PermissionState.GRANTED) {
            JSObject permissionsResultJSON = new JSObject();
            permissionsResultJSON.put("receive", "granted");
            call.resolve(permissionsResultJSON);
        } else {
            requestPermissionForAlias(PUSH_NOTIFICATIONS, call, "permissionsCallback");
        }
    }

    @PluginMethod
    public void registerPush(PluginCall call) {
        FirebaseMessaging.getInstance().setAutoInitEnabled(true);
        FirebaseMessaging.getInstance()
            .getToken()
            .addOnCompleteListener((task) -> {
                if (!task.isSuccessful()) {
                    sendError("Unable to register Android push token");
                    return;
                }
                sendToken(task.getResult());
            });
        call.resolve();
    }

    @PluginMethod
    public void unregisterPush(PluginCall call) {
        FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        FirebaseMessaging.getInstance().deleteToken();
        call.resolve();
    }

    @PluginMethod
    public void setBadge(PluginCall call) {
        int count = Math.max(0, call.getInt("count", 0));
        preferences.edit().putInt(BADGE_KEY, count).apply();
        JSObject result = new JSObject();
        result.put("count", count);
        call.resolve(result);
    }

    @PluginMethod
    public void clearBadge(PluginCall call) {
        preferences.edit().putInt(BADGE_KEY, 0).apply();
        JSObject result = new JSObject();
        result.put("count", 0);
        call.resolve(result);
    }

    @PluginMethod
    public void getBadge(PluginCall call) {
        JSObject result = new JSObject();
        result.put("count", preferences.getInt(BADGE_KEY, 0));
        call.resolve(result);
    }

    @PluginMethod
    public void getNativeInstallId(PluginCall call) {
        String installId = preferences.getString(INSTALL_ID_KEY, null);
        if (installId == null || installId.isEmpty()) {
            installId = UUID.randomUUID().toString();
            preferences.edit().putString(INSTALL_ID_KEY, installId).apply();
        }
        JSObject result = new JSObject();
        result.put("nativeInstallId", installId);
        call.resolve(result);
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject result = new JSObject();
        try {
            PackageManager packageManager = getContext().getPackageManager();
            PackageInfo packageInfo = packageManager.getPackageInfo(getContext().getPackageName(), 0);
            ApplicationInfo applicationInfo = packageManager.getApplicationInfo(getContext().getPackageName(), 0);
            result.put("version", packageInfo.versionName == null ? "" : packageInfo.versionName);
            result.put("build", String.valueOf(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? packageInfo.getLongVersionCode() : packageInfo.versionCode));
            result.put("name", packageManager.getApplicationLabel(applicationInfo).toString());
            result.put("id", getContext().getPackageName());
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException exception) {
            call.reject(exception.getMessage());
        }
    }

    @PluginMethod
    public void createDefaultChannel(PluginCall call) {
        notificationChannelManager.createDefaultChannel(call);
    }

    @PluginMethod
    public void createChannel(PluginCall call) {
        notificationChannelManager.createChannel(call);
    }

    @PluginMethod
    public void deleteChannel(PluginCall call) {
        notificationChannelManager.deleteChannel(call);
    }

    @PluginMethod
    public void listChannels(PluginCall call) {
        notificationChannelManager.listChannels(call);
    }

    @PluginMethod
    public void getDeliveredNotifications(PluginCall call) {
        JSArray notifications = new JSArray();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            JSObject result = new JSObject();
            result.put("notifications", notifications);
            call.resolve(result);
            return;
        }
        StatusBarNotification[] activeNotifications = notificationManager.getActiveNotifications();
        for (StatusBarNotification notif : activeNotifications) {
            JSObject jsNotif = new JSObject();
            jsNotif.put("id", notif.getId());
            jsNotif.put("tag", notif.getTag());
            Notification notification = notif.getNotification();
            if (notification != null) {
                jsNotif.put("title", notification.extras.getCharSequence(Notification.EXTRA_TITLE));
                jsNotif.put("body", notification.extras.getCharSequence(Notification.EXTRA_TEXT));
                jsNotif.put("group", notification.getGroup());
                jsNotif.put("groupSummary", 0 != (notification.flags & Notification.FLAG_GROUP_SUMMARY));
                JSObject extras = new JSObject();
                for (String key : notification.extras.keySet()) {
                    extras.put(key, notification.extras.get(key));
                }
                jsNotif.put("data", extras);
            }
            notifications.put(jsNotif);
        }
        JSObject result = new JSObject();
        result.put("notifications", notifications);
        call.resolve(result);
    }

    @PluginMethod
    public void removeDeliveredNotifications(PluginCall call) {
        JSArray notifications = call.getArray("notifications");
        if (notifications == null) {
            call.reject("notifications is required");
            return;
        }
        try {
            for (Object item : notifications.toList()) {
                if (item instanceof JSONObject) {
                    JSObject notif = JSObject.fromJSONObject((JSONObject) item);
                    String tag = notif.getString("tag");
                    Integer id = notif.getInteger("id");
                    if (id == null) {
                        call.reject("notification id is required");
                        return;
                    }
                    if (tag == null) {
                        notificationManager.cancel(id);
                    } else {
                        notificationManager.cancel(tag, id);
                    }
                } else {
                    call.reject("Expected notifications to be a list of notification objects");
                    return;
                }
            }
        } catch (JSONException exception) {
            call.reject(exception.getMessage());
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void removeAllDeliveredNotifications(PluginCall call) {
        notificationManager.cancelAll();
        preferences.edit().putInt(BADGE_KEY, 0).apply();
        call.resolve();
    }

    @PluginMethod
    public void completeBackgroundNotification(PluginCall call) {
        JSObject result = new JSObject();
        result.put("completed", false);
        call.resolve(result);
    }

    public void sendToken(String token) {
        JSObject data = new JSObject();
        data.put("value", token);
        notifyListeners(EVENT_TOKEN_CHANGE, data, true);
    }

    public void sendError(String error) {
        JSObject data = new JSObject();
        data.put("error", error);
        notifyListeners(EVENT_TOKEN_ERROR, data, true);
    }

    public static void onNewToken(String newToken) {
        CapgoNotificationsPlugin plugin = CapgoNotificationsPlugin.getCapgoNotificationsInstance();
        if (plugin != null) {
            plugin.sendToken(newToken);
        }
    }

    public static void sendRemoteMessage(RemoteMessage remoteMessage) {
        CapgoNotificationsPlugin plugin = CapgoNotificationsPlugin.getCapgoNotificationsInstance();
        if (plugin != null) {
            plugin.fireNotification(remoteMessage);
        } else {
            synchronized (pendingMessagesLock) {
                if (pendingMessages.size() >= MAX_PENDING_MESSAGES) {
                    pendingMessages.poll();
                }
                pendingMessages.add(remoteMessage);
            }
        }
    }

    public void fireNotification(RemoteMessage remoteMessage) {
        JSObject remoteMessageData = new JSObject();
        JSObject data = new JSObject();
        remoteMessageData.put("id", remoteMessage.getMessageId());
        for (String key : remoteMessage.getData().keySet()) {
            data.put(key, remoteMessage.getData().get(key));
        }
        remoteMessageData.put("data", data);

        RemoteMessage.Notification notification = remoteMessage.getNotification();
        if (notification != null) {
            String title = notification.getTitle();
            String body = notification.getBody();
            String[] presentation = getConfig().getArray("presentationOptions");
            if (presentation != null && Arrays.asList(presentation).contains("alert")) {
                Bundle bundle = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? getBundleApi33() : getBundleLegacy();
                if (bundle != null) {
                    NotificationParams params = new NotificationParams(remoteMessage.toIntent().getExtras());
                    String channelId = CommonNotificationBuilder.getOrCreateChannel(getContext(), params.getNotificationChannelId(), bundle);
                    CommonNotificationBuilder.DisplayNotificationInfo notificationInfo = CommonNotificationBuilder.createNotificationInfo(getContext(), getContext(), params, channelId, bundle);
                    notificationManager.notify(notificationInfo.tag, notificationInfo.id, notificationInfo.notificationBuilder.build());
                }
            }
            remoteMessageData.put("title", title);
            remoteMessageData.put("body", body);
            remoteMessageData.put("click_action", notification.getClickAction());
            Uri link = notification.getLink();
            if (link != null) {
                remoteMessageData.put("link", link.toString());
            }
        }

        notifyListeners("notificationReceived", remoteMessageData, true);
        if (isCapgoBackgroundMessage(remoteMessage)) {
            notifyListeners("backgroundNotification", remoteMessageData, true);
        }
    }

    public static CapgoNotificationsPlugin getCapgoNotificationsInstance() {
        if (staticBridge != null && staticBridge.getWebView() != null) {
            PluginHandle handle = staticBridge.getPlugin("CapgoNotifications");
            if (handle == null) {
                return null;
            }
            return (CapgoNotificationsPlugin) handle.getInstance();
        }
        return null;
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        this.checkPermissions(call);
    }

    private boolean isCapgoBackgroundMessage(RemoteMessage remoteMessage) {
        String action = remoteMessage.getData().get("capgoAction");
        if (action == null) {
            action = remoteMessage.getData().get("capgo_action");
        }
        return "update_check".equals(action) || "capgo_update_check".equals(action) || "background".equals(action);
    }

    @SuppressWarnings("deprecation")
    private Bundle getBundleLegacy() {
        try {
            ApplicationInfo applicationInfo = getContext().getPackageManager().getApplicationInfo(getContext().getPackageName(), PackageManager.GET_META_DATA);
            return applicationInfo.metaData;
        } catch (PackageManager.NameNotFoundException exception) {
            exception.printStackTrace();
            return null;
        }
    }

    private Bundle getBundleApi33() {
        try {
            ApplicationInfo applicationInfo = getContext()
                .getPackageManager()
                .getApplicationInfo(getContext().getPackageName(), PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA));
            return applicationInfo.metaData;
        } catch (PackageManager.NameNotFoundException exception) {
            exception.printStackTrace();
            return null;
        }
    }
}
