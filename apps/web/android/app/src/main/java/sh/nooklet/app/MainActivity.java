package sh.nooklet.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * Proposal 006 Phase 1 (ADR 033): text shared to nooklet from another app (an ACTION_SEND
 * intent filter in AndroidManifest.xml) is rewritten into a {@code nooklet://capture?text=…&title=…}
 * link before Capacitor sees the intent. From there it is an ordinary deep link: {@code @capacitor/app}
 * delivers it as {@code appUrlOpen} (or {@code getLaunchUrl()} on a cold start) and the web layer
 * opens the capture screen pre-filled. Nothing is saved until the person taps Save.
 *
 * <p>Our own few lines rather than a third-party share-target plugin: there is one intent to
 * translate and the deep-link path already exists. Untested on a device or emulator (no Android
 * toolchain where this was written).
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super: the bridge reads the launch intent's data URI while it is created.
        Intent link = captureLinkFromShare(getIntent());
        if (link != null) setIntent(link);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        Intent link = captureLinkFromShare(intent);
        if (link != null) setIntent(link);
        super.onNewIntent(link != null ? link : intent);
    }

    /** An ACTION_SEND of text as an ACTION_VIEW of {@code nooklet://capture}, or null for any other intent. */
    static Intent captureLinkFromShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return null;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        Uri.Builder uri = new Uri.Builder().scheme("nooklet").authority("capture");
        // A shared link usually arrives as the text; the web side (`formatCapture`) recognises a
        // bare URL there and pairs it with the subject as `[subject](url)`.
        if (text != null && text.length() > 0) uri.appendQueryParameter("text", text.toString());
        if (subject != null && !subject.isEmpty()) uri.appendQueryParameter("title", subject);
        return new Intent(Intent.ACTION_VIEW, uri.build());
    }
}
