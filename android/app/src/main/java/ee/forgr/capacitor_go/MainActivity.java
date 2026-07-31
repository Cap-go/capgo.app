package ee.forgr.capacitor_go;

import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import androidx.appcompat.app.AlertDialog;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String NATIVE_CONFIRMED_PREVIEW_PARAM = "nativeConfirmedPreview";
    private static final String PREVIEW_BUNDLE_PATH = "/preview/bundle";
    private static final String PREVIEW_CHANNEL_PATH = "/preview/channel";

    private boolean previewConfirmationVisible = false;
    private Intent pendingPreviewIntent;
    private Intent dialogPreviewIntent;
    private AlertDialog previewConfirmationDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Intent launchIntent = getIntent();
        if (isPreviewDeepLinkIntent(launchIntent)) {
            pendingPreviewIntent = new Intent(launchIntent);
            setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER));
        }

        super.onCreate(savedInstanceState);

        if (pendingPreviewIntent != null) {
            showPreviewConfirmation(pendingPreviewIntent);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        if (isPreviewDeepLinkIntent(intent)) {
            if (previewConfirmationVisible) {
                return;
            }

            pendingPreviewIntent = new Intent(intent);
            showPreviewConfirmation(pendingPreviewIntent);
            return;
        }

        super.onNewIntent(intent);
    }

    @Override
    public void onDestroy() {
        dismissPreviewConfirmationDialog();
        super.onDestroy();
    }

    private void showPreviewConfirmation(Intent intent) {
        if (previewConfirmationVisible) {
            return;
        }

        previewConfirmationVisible = true;
        dialogPreviewIntent = new Intent(intent);
        final Intent confirmationIntent = dialogPreviewIntent;
        runOnUiThread(() -> {
            Uri previewUri = confirmationIntent.getData();
            previewConfirmationDialog = new AlertDialog.Builder(this)
                .setTitle("Load preview?")
                .setMessage(previewConfirmationMessage(previewUri))
                .setNegativeButton("No", null)
                .setPositiveButton("Load preview", this::confirmPreviewFromDialog)
                .setOnCancelListener(this::onPreviewDialogCancelled)
                .setOnDismissListener(this::onPreviewDialogDismissed)
                .create();
            previewConfirmationDialog.show();
        });
    }

    private void confirmPreviewFromDialog(DialogInterface dialog, int which) {
        if (dialog == null && which != DialogInterface.BUTTON_POSITIVE) {
            return;
        }

        confirmPreviewIntent(dialogPreviewIntent);
    }

    private void onPreviewDialogCancelled(DialogInterface dialog) {
        if (dialog == null && !previewConfirmationVisible) {
            return;
        }

        cancelPreviewConfirmation();
    }

    private void onPreviewDialogDismissed(DialogInterface dialog) {
        if (dialog == null && !previewConfirmationVisible) {
            return;
        }

        cancelPreviewConfirmation();
    }

    private void dismissPreviewConfirmationDialog() {
        AlertDialog dialog = previewConfirmationDialog;
        previewConfirmationDialog = null;
        if (dialog != null && dialog.isShowing()) {
            dialog.dismiss();
        }
    }

    private void cancelPreviewConfirmation() {
        dismissPreviewConfirmationDialog();
        pendingPreviewIntent = null;
        dialogPreviewIntent = null;
        previewConfirmationVisible = false;
    }

    private void confirmPreviewIntent(Intent intent) {
        dismissPreviewConfirmationDialog();
        pendingPreviewIntent = null;
        dialogPreviewIntent = null;
        previewConfirmationVisible = false;
        if (intent == null) {
            return;
        }

        Intent confirmedIntent = withNativeConfirmedPreview(intent);
        setIntent(confirmedIntent);
        super.onNewIntent(confirmedIntent);
    }

    private Intent withNativeConfirmedPreview(Intent intent) {
        Intent confirmedIntent = new Intent(intent);
        Uri previewUri = confirmedIntent.getData();
        if (previewUri != null && previewUri.getQueryParameter(NATIVE_CONFIRMED_PREVIEW_PARAM) == null) {
            confirmedIntent.setData(previewUri.buildUpon().appendQueryParameter(NATIVE_CONFIRMED_PREVIEW_PARAM, "1").build());
        }
        return confirmedIntent;
    }

    private boolean isPreviewDeepLinkIntent(Intent intent) {
        return intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && isPreviewDeepLink(intent.getData());
    }

    private boolean isPreviewDeepLink(Uri uri) {
        if (uri == null) {
            return false;
        }

        String path = previewPath(uri);
        return PREVIEW_BUNDLE_PATH.equals(path) || PREVIEW_CHANNEL_PATH.equals(path);
    }

    private String previewPath(Uri uri) {
        if ("capgo".equals(uri.getScheme())) {
            String host = uri.getHost() == null ? "" : uri.getHost();
            String path = uri.getPath() == null ? "" : uri.getPath();
            return ("/" + host + path).replaceAll("/+", "/");
        }

        return uri.getPath();
    }

    private String previewConfirmationMessage(Uri uri) {
        String appLabel = firstQueryValue(uri, "appId", "app");
        if (appLabel == null || appLabel.isEmpty()) {
            appLabel = "Unknown app";
        }

        String target = previewTargetLabel(uri);
        return "A preview link wants to load:\n\nApp: " + appLabel + "\nTarget: " + target;
    }

    private String previewTargetLabel(Uri uri) {
        String path = previewPath(uri);
        if (PREVIEW_CHANNEL_PATH.equals(path)) {
            String channel = firstQueryValue(uri, "channel", "channelName");
            return channel == null || channel.isEmpty() ? "Channel preview" : "Channel " + channel;
        }

        String version = firstQueryValue(uri, "versionId", "bundleId");
        return version == null || version.isEmpty() ? "Bundle preview" : "Bundle " + version;
    }

    private String firstQueryValue(Uri uri, String... names) {
        if (uri == null) {
            return null;
        }

        for (String name : names) {
            String value = uri.getQueryParameter(name);
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }

        return null;
    }
}
