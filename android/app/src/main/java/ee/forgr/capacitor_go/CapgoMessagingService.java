package ee.forgr.capacitor_go;

import androidx.annotation.NonNull;
import app.capgo.capacitornotifications.CapgoNotificationsPlugin;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Android delivers FCM messages to a single MESSAGING_EVENT service. Capgo's own
 * notifications (live update pushes) and @capacitor/push-notifications (kept so
 * previewed apps can call it) each declare one, so the manifest removes both and
 * this service fans every message and token out to the two plugins.
 */
public class CapgoMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        CapgoNotificationsPlugin.sendRemoteMessage(remoteMessage);
        PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        CapgoNotificationsPlugin.onNewToken(token);
        PushNotificationsPlugin.onNewToken(token);
    }
}
