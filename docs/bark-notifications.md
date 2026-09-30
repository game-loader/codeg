# Bark task completion notifications

Codeg sends a Bark notification from the computer running the agent after a
successful final reply. The iOS app can be closed or the phone locked.

## Setup

1. Install Bark on the phone and copy its device URL, for example
   `https://api.day.app/<device-key>`.
2. In Codeg iOS, select the server and open **Settings → Notifications**.
   In the server browser or desktop app, open
   **Settings → General → Bark completion notifications**.
3. Paste the Bark URL, enable notifications, set a source name, and save.
   Use **Test notification** to verify delivery. Testing also works while
   automatic notifications are disabled, after the URL has been saved.

Each server stores its own subscriptions. Repeat setup on each remote server
that should notify the phone. The same Bark URL can be used on several servers.
The browser and desktop share a server subscription; their selector can also
edit existing subscriptions registered by iOS. Configure the local desktop
from its local window, or a remote server from that remote workspace's window.

## Distinguishing remote workspaces

Set a source name such as **Academic server** or **Machines server**. Notifications
show **Codeg · Academic server** as the title and the conversation's folder name
and conversation title beneath it. Folder aliases and worktree folder names are
included; folderless chats show only the conversation title. Source names are
display labels, while routing uses the server identity and conversation ID.
Different servers get independent notification groups even if their
conversation IDs are the same.

iOS subscriptions link to the saved server profile that registered them. For a
browser or desktop subscription, fill in the optional **Codeg server URL** with
an address already saved in Codeg iOS. Tapping a notification opens that matching
server and conversation. Unknown or ambiguous servers are ignored. Leaving the
address blank still delivers notifications without a conversation link.

Reply previews are optional and disabled by default. Enabling them adds up to
300 characters of the final reply to the notification. The source, folder name,
and conversation title are always included when available.

## Delivery

Delivery requires the agent's Codeg server or desktop process to remain running
and be able to reach Bark. The sender waits for queued input, pending approvals,
and background/delegated work to finish. Failed, cancelled, empty, tool-only,
and child-agent turns do not trigger completion notifications. Disabling a
subscription suppresses a notification that is still waiting to be sent.

The Bark URL contains a device credential. Codeg masks it in settings and does
not include it in logs or notification links. Self-hosted Bark HTTP/HTTPS URLs,
including reverse-proxy prefixes, are supported.
