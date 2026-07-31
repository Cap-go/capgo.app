package app.capgo.capacitornotifications;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.PluginCall;
import com.getcapacitor.util.WebColor;
import java.util.List;

public class NotificationChannelManager {

    private final Context context;
    private final NotificationManager notificationManager;

    private static final String CHANNEL_ID = "id";
    private static final String CHANNEL_NAME = "name";
    private static final String CHANNEL_DESCRIPTION = "description";
    private static final String CHANNEL_IMPORTANCE = "importance";
    private static final String CHANNEL_VISIBILITY = "visibility";
    private static final String CHANNEL_SOUND = "sound";
    private static final String CHANNEL_VIBRATE = "vibration";
    private static final String CHANNEL_USE_LIGHTS = "lights";
    private static final String CHANNEL_LIGHT_COLOR = "lightColor";
    private static final String CHANNEL_SHOW_BADGE = "showBadge";

    public NotificationChannelManager(Context context, NotificationManager manager) {
        this.context = context;
        this.notificationManager = manager;
    }

    public void createDefaultChannel(PluginCall call) {
        JSObject channel = new JSObject();
        channel.put(CHANNEL_ID, call.getString(CHANNEL_ID, "capgo"));
        channel.put(CHANNEL_NAME, call.getString(CHANNEL_NAME, "Capgo"));
        channel.put(CHANNEL_DESCRIPTION, call.getString(CHANNEL_DESCRIPTION, "Capgo notifications"));
        channel.put(CHANNEL_IMPORTANCE, call.getInt(CHANNEL_IMPORTANCE, NotificationManager.IMPORTANCE_DEFAULT));
        channel.put(CHANNEL_VISIBILITY, call.getInt(CHANNEL_VISIBILITY, NotificationCompat.VISIBILITY_PUBLIC));
        channel.put(CHANNEL_SOUND, call.getString(CHANNEL_SOUND, null));
        channel.put(CHANNEL_VIBRATE, call.getBoolean(CHANNEL_VIBRATE, true));
        channel.put(CHANNEL_USE_LIGHTS, call.getBoolean(CHANNEL_USE_LIGHTS, false));
        channel.put(CHANNEL_LIGHT_COLOR, call.getString(CHANNEL_LIGHT_COLOR, null));
        channel.put(CHANNEL_SHOW_BADGE, call.getBoolean(CHANNEL_SHOW_BADGE, true));
        createChannel(channel);
        call.resolve();
    }

    public void createChannel(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            JSObject channel = new JSObject();
            if (call.getString(CHANNEL_ID) != null) {
                channel.put(CHANNEL_ID, call.getString(CHANNEL_ID));
            } else {
                call.reject("Channel missing identifier");
                return;
            }
            if (call.getString(CHANNEL_NAME) != null) {
                channel.put(CHANNEL_NAME, call.getString(CHANNEL_NAME));
            } else {
                call.reject("Channel missing name");
                return;
            }
            channel.put(CHANNEL_IMPORTANCE, call.getInt(CHANNEL_IMPORTANCE, NotificationManager.IMPORTANCE_DEFAULT));
            channel.put(CHANNEL_DESCRIPTION, call.getString(CHANNEL_DESCRIPTION, ""));
            channel.put(CHANNEL_VISIBILITY, call.getInt(CHANNEL_VISIBILITY, NotificationCompat.VISIBILITY_PUBLIC));
            channel.put(CHANNEL_SOUND, call.getString(CHANNEL_SOUND, null));
            channel.put(CHANNEL_VIBRATE, call.getBoolean(CHANNEL_VIBRATE, false));
            channel.put(CHANNEL_USE_LIGHTS, call.getBoolean(CHANNEL_USE_LIGHTS, false));
            channel.put(CHANNEL_LIGHT_COLOR, call.getString(CHANNEL_LIGHT_COLOR, null));
            channel.put(CHANNEL_SHOW_BADGE, call.getBoolean(CHANNEL_SHOW_BADGE, true));
            createChannel(channel);
            call.resolve();
        } else {
            call.unavailable();
        }
    }

    public void createChannel(JSObject channel) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel notificationChannel = new NotificationChannel(
                channel.getString(CHANNEL_ID),
                channel.getString(CHANNEL_NAME),
                channel.getInteger(CHANNEL_IMPORTANCE)
            );
            notificationChannel.setDescription(channel.getString(CHANNEL_DESCRIPTION));
            notificationChannel.setLockscreenVisibility(channel.getInteger(CHANNEL_VISIBILITY));
            notificationChannel.enableVibration(channel.getBool(CHANNEL_VIBRATE));
            notificationChannel.enableLights(channel.getBool(CHANNEL_USE_LIGHTS));
            notificationChannel.setShowBadge(channel.getBool(CHANNEL_SHOW_BADGE));
            String lightColor = channel.getString(CHANNEL_LIGHT_COLOR);
            if (lightColor != null) {
                try {
                    notificationChannel.setLightColor(WebColor.parseColor(lightColor));
                } catch (IllegalArgumentException ex) {
                    Logger.error(Logger.tags("CapgoNotificationChannel"), "Invalid light color.", null);
                }
            }
            String sound = channel.getString(CHANNEL_SOUND, null);
            if (sound != null && !sound.isEmpty()) {
                if (sound.contains(".")) {
                    sound = sound.substring(0, sound.lastIndexOf('.'));
                }
                AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build();
                Uri soundUri = Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.getPackageName() + "/raw/" + sound);
                notificationChannel.setSound(soundUri, audioAttributes);
            }
            notificationManager.createNotificationChannel(notificationChannel);
        }
    }

    public void deleteChannel(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            String channelId = call.getString("id");
            if (channelId == null) {
                call.reject("Channel id is required");
                return;
            }
            notificationManager.deleteNotificationChannel(channelId);
            call.resolve();
        } else {
            call.unavailable();
        }
    }

    public void listChannels(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            List<NotificationChannel> notificationChannels = notificationManager.getNotificationChannels();
            JSArray channels = new JSArray();
            for (NotificationChannel notificationChannel : notificationChannels) {
                JSObject channel = new JSObject();
                channel.put(CHANNEL_ID, notificationChannel.getId());
                channel.put(CHANNEL_NAME, notificationChannel.getName());
                channel.put(CHANNEL_DESCRIPTION, notificationChannel.getDescription());
                channel.put(CHANNEL_IMPORTANCE, notificationChannel.getImportance());
                channel.put(CHANNEL_VISIBILITY, notificationChannel.getLockscreenVisibility());
                channel.put(CHANNEL_SOUND, notificationChannel.getSound());
                channel.put(CHANNEL_VIBRATE, notificationChannel.shouldVibrate());
                channel.put(CHANNEL_USE_LIGHTS, notificationChannel.shouldShowLights());
                channel.put(CHANNEL_SHOW_BADGE, notificationChannel.canShowBadge());
                channel.put(CHANNEL_LIGHT_COLOR, String.format("#%06X", (0xFFFFFF & notificationChannel.getLightColor())));
                channels.put(channel);
            }
            JSObject result = new JSObject();
            result.put("channels", channels);
            call.resolve(result);
        } else {
            call.unavailable();
        }
    }
}
