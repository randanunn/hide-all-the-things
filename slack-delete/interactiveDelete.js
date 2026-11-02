import { WebClient } from '@slack/web-api';
import readline from 'readline';

// These come from .env (gitignored); never hardcode them here
const USER_TOKEN = process.env.SLACK_USER_TOKEN;
const TARGET_USER_ID = process.env.SLACK_TARGET_USER_ID;

const client = new WebClient(USER_TOKEN);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

// Fetch user details including real name, display name, and email
async function getUserMap() {
  const userMap = new Map();
  let cursor;

  try {
    do {
      const res = await client.users.list({ limit: 200, cursor });
      for (const u of res.members || []) {
        const realName = u.profile?.real_name || u.real_name || '';
        const displayName = u.profile?.display_name || u.name || '';
        const email = u.profile?.email ? ` (${u.profile.email})` : '';

        const label = displayName && displayName !== realName
          ? `${realName} (@${displayName}${email})`
          : `${realName}${email}`;

        userMap.set(u.id, label.trim() || u.id);
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);
  } catch (err) {
    console.warn(`Could not fetch full user directory: ${err.message}`);
  }

  userMap.set('USLACKBOT', 'Slackbot');
  return userMap;
}

// Inspect DM participants when Slack leaves conv.user blank
async function resolveDMUserId(channelId, currentUserId) {
  try {
    const res = await client.conversations.members({ channel: channelId });
    if (res.members) {
      const otherUser = res.members.find((id) => id !== currentUserId);
      return otherUser || currentUserId;
    }
  } catch {
    // If membership query fails, return null to fall back to ID
  }
  return null;
}

async function getAllConversations() {
  const conversations = [];
  let cursor;

  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel,mpim,im',
      cursor,
      limit: 200,
    });

    if (res.channels) {
      const active = res.channels.filter((c) => c.is_member || c.is_im);
      conversations.push(...active);
    }

    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  return conversations;
}

async function getMessagesByUser(channelId, userId) {
  const messagesToDelete = [];
  let cursor;

  do {
    const res = await client.conversations.history({
      channel: channelId,
      cursor,
      limit: 100,
    });

    if (res.messages) {
      for (const msg of res.messages) {
        if (msg.user === userId) {
          messagesToDelete.push({ ts: msg.ts, text: msg.text });
        }

        // Check replies within thread
        if (msg.thread_ts && msg.reply_count > 0) {
          await sleep(400);
          const threadRes = await client.conversations.replies({
            channel: channelId,
            ts: msg.thread_ts,
          });

          if (threadRes.messages) {
            for (const reply of threadRes.messages) {
              if (reply.user === userId && reply.ts !== msg.ts) {
                messagesToDelete.push({ ts: reply.ts, text: reply.text });
              }
            }
          }
        }
      }
    }

    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  return messagesToDelete;
}

async function run() {
  try {
    console.log('Fetching conversations and resolving user identities...');
    const [conversations, userMap] = await Promise.all([
      getAllConversations(),
      getUserMap(),
    ]);

    if (conversations.length === 0) {
      console.log('No channels or DMs found.');
      return;
    }

    // Build human-readable names for channels and DMs
    const formattedList = [];

    for (let idx = 0; idx < conversations.length; idx++) {
      const conv = conversations[idx];
      let displayName = conv.name ? `#${conv.name}` : 'Unknown';
      let type = 'Public Channel';

      if (conv.is_im) {
        type = 'Direct Message';
        let targetId = conv.user;

        if (!targetId) {
          targetId = await resolveDMUserId(conv.id, TARGET_USER_ID);
        }

        if (targetId === TARGET_USER_ID) {
          displayName = 'Notes to Self (Your personal DM)';
        } else {
          const person = userMap.get(targetId) || targetId;
          displayName = `DM with ${person}`;
        }
      } else if (conv.is_mpim) {
        type = 'Group DM';
        displayName = conv.purpose?.value || conv.name;
      } else if (conv.is_private) {
        type = 'Private Channel';
      }

      formattedList.push({ index: idx + 1, id: conv.id, name: displayName, type });
    }

    console.log('\n--- Accessible Conversations ---');
    formattedList.forEach((c) => {
      console.log(`[${c.index}] [${c.type}] ${c.name}`);
    });
    console.log('--------------------------------\n');

    const input = await askQuestion(
      'Enter the numbers to delete from (e.g. "1, 3, 5" or "all" to select everything): '
    );

    let selected = [];
    if (input.toLowerCase() === 'all') {
      selected = formattedList;
    } else {
      const indices = input
        .split(',')
        .map((num) => parseInt(num.trim(), 10))
        .filter((num) => !isNaN(num) && num > 0 && num <= formattedList.length);

      selected = formattedList.filter((c) => indices.includes(c.index));
    }

    if (selected.length === 0) {
      console.log('No valid conversations selected. Exiting.');
      return;
    }

    console.log(`\nYou selected ${selected.length} conversation(s):`);
    selected.forEach((c) => console.log(` - ${c.name}`));

    const confirm = await askQuestion(
      '\nAre you sure you want to delete all your messages in these conversations? (yes/no): '
    );

    if (confirm.toLowerCase() !== 'yes') {
      console.log('Operation aborted. No messages were deleted.');
      return;
    }

    // Process deletions
    for (const conv of selected) {
      console.log(`\nScanning ${conv.name}...`);
      const messages = await getMessagesByUser(conv.id, TARGET_USER_ID);
      console.log(`Found ${messages.length} message(s) authored by you.`);

      for (const msg of messages) {
        try {
          const preview = msg.text
            ? msg.text.replace(/\n/g, ' ').slice(0, 35)
            : '[Attachment/Block]';
          console.log(` Deleting [${msg.ts}]: "${preview}..."`);
          await client.chat.delete({
            channel: conv.id,
            ts: msg.ts,
          });
          await sleep(1200); // 1.2s delay to prevent HTTP 429 rate limits
        } catch (err) {
          console.error(` Failed to delete message ${msg.ts}: ${err.message}`);
        }
      }
    }

    console.log('\nFinished processing all selected conversations.');
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

run();
