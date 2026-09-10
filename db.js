import { sb, state } from './core.js';

// ===================== data access (all mf_-prefixed) =====================
const PROF = 'id, username, avatar, bio, pubkey, created_at, profile_private, privacy_locked';
const db = {
    // ---- profiles ----
    myProfile: () => sb.from('mf_profiles').select('*').eq('id', state.me.id).maybeSingle(),
    profile:   (username) => sb.from('mf_profiles').select('*').eq('username', username).maybeSingle(),
    profileById: (id) => sb.from('mf_profiles').select(PROF).eq('id', id).maybeSingle(),
    publicFriendCount: (id) => sb.rpc('mf_public_friend_count', { profile_id: id }),
    updateProfile: (patch) => sb.from('mf_profiles').update(patch).eq('id', state.me.id),
    adminDeleteUser: (targetId) => sb.functions.invoke('admin-delete-user', { body: { targetId } }),
    adminSetProfilePrivacy: (targetId, forcePrivate) => sb.functions.invoke('admin-profile-privacy', { body: { targetId, forcePrivate } }),
    upsertProfile: (row) => sb.from('mf_profiles').upsert({ id: state.me.id, ...row }).select().maybeSingle(),
    registerDevice: (pubkey, label = '') => sb.from('mf_devices').upsert({ id: state.deviceId, user_id: state.me.id, pubkey: JSON.stringify(pubkey), label, last_seen_at: new Date().toISOString(), revoked_at: null }, { onConflict: 'id' }),
    touchDevice: () => sb.from('mf_devices').update({ last_seen_at: new Date().toISOString() }).eq('id', state.deviceId).eq('user_id', state.me.id),
    touchActivity: () => sb.rpc('mf_touch_activity'),
    friendActivity: () => sb.rpc('mf_friend_activity'),
    devicesForUser: (userId) => sb.from('mf_devices').select('id, pubkey').eq('user_id', userId).is('revoked_at', null),
    claimCall: (callId) => sb.rpc('mf_claim_call', { call_id: callId, device_id: state.deviceId }),
    searchProfiles: (q) => sb.from('mf_profiles').select(PROF).eq('profile_private', false).ilike('username', `%${q}%`).neq('id', state.me.id).limit(50),
    allProfiles: () => sb.from('mf_profiles').select(PROF).eq('profile_private', false).neq('id', state.me.id).order('created_at', { ascending: false }).limit(50),
    adminSearchProfiles: (q) => sb.from('mf_profiles').select(PROF).ilike('username', `%${q}%`).limit(50),

    // ---- friends (symmetric: one row per pair, either direction) ----
    friends: () => sb.from('mf_friends')
        .select('*, requester:requester_id(' + PROF + '), addressee:addressee_id(' + PROF + ')')
        .eq('status', 'accepted').or(`requester_id.eq.${state.me.id},addressee_id.eq.${state.me.id}`),
    incomingRequests: () => sb.from('mf_friends')
        .select('*, requester:requester_id(' + PROF + ')')
        .eq('status', 'pending').eq('addressee_id', state.me.id).order('created_at', { ascending: false }),
    outgoingRequests: () => sb.from('mf_friends')
        .select('addressee_id').eq('status', 'pending').eq('requester_id', state.me.id),
    friendState: (otherId) => sb.from('mf_friends').select('*')
        .or(`and(requester_id.eq.${state.me.id},addressee_id.eq.${otherId}),and(requester_id.eq.${otherId},addressee_id.eq.${state.me.id})`)
        .maybeSingle(),
    sendRequest:  (addressee_id) => sb.from('mf_friends').insert({ requester_id: state.me.id, addressee_id, status: 'pending' }),
    acceptRequest: (requester_id) => sb.from('mf_friends').update({ status: 'accepted' })
        .match({ requester_id, addressee_id: state.me.id, status: 'pending' }),
    // works for decline / cancel / unfriend regardless of direction
    removeFriend: (otherId) => sb.from('mf_friends').delete()
        .or(`and(requester_id.eq.${state.me.id},addressee_id.eq.${otherId}),and(requester_id.eq.${otherId},addressee_id.eq.${state.me.id})`),

    // ---- snaps ----
    // inbox: unopened snaps sent to me, newest first, with sender profile
    inbox: () => sb.from('mf_snaps')
        .select('*, sender:sender_id(' + PROF + ')')
        .eq('recipient_id', state.me.id).or(`recipient_device_id.eq.${state.deviceId},recipient_device_id.is.null`).is('viewed_at', null).gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    // pending (unopened) relay snaps I've sent to one recipient — for the offline cap
    pendingRelayTo: (recipient_id) => sb.rpc('mf_pending_relay_count', { other_id: recipient_id }).then(({ data, error }) => ({ count: Number(data || 0), error })),
    // total unopened, non-expired relay snaps I've sent across all recipients — the hard per-sender cap
    pendingLegacyRelayTotal: () => sb.from('mf_snaps')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', state.me.id).like('delivery', 'relay%').is('relay_id', null)
        .is('viewed_at', null).gt('expires_at', new Date().toISOString()),
    pendingSharedRelayTotal: () => sb.from('mf_relay_payloads')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', state.me.id).gt('expires_at', new Date().toISOString()),
    addSnap: (row) => sb.from('mf_snaps').insert(row).select().maybeSingle(),
    markSnapDelivered: (id) => sb.from('mf_snaps').update({ delivered_at: new Date().toISOString() })
        .eq('id', id).is('delivered_at', null),
    markSnapOpened: (id) => sb.from('mf_snaps').update({ opened_at: new Date().toISOString(), viewed_at: new Date().toISOString() })
        .eq('id', id),
    claimSnap: (id) => sb.rpc('mf_claim_snap', { snap_id: id, device_id: state.deviceId }),
    delSnap: (id) => sb.from('mf_snaps').delete().eq('id', id),
    delSnaps: (ids) => sb.from('mf_snaps').delete().in('id', ids),
    // snaps I sent that have now been opened / expired → clean up my device copies
    mySpentSnaps: () => sb.from('mf_snaps').select('id').eq('sender_id', state.me.id),
    // expired snaps I'm party to (RLS scopes to sender/recipient) → swept on boot: rows + relay blobs
    myExpiredSnaps: () => sb.from('mf_snaps').select('id, delivery, relay_id').lt('expires_at', new Date().toISOString()),
    addRelayPayload: (row) => sb.from('mf_relay_payloads').insert(row),
    relayPayload: (id) => sb.from('mf_relay_payloads').select('id, content_iv, mime, expires_at').eq('id', id).maybeSingle(),
    myExpiredRelayPayloads: () => sb.from('mf_relay_payloads').select('id').eq('sender_id', state.me.id).lt('expires_at', new Date().toISOString()),
    delRelayPayloads: (ids) => sb.from('mf_relay_payloads').delete().in('id', ids),
    pendingTransfersTo: (recipient_id) => sb.rpc('mf_pending_relay_count', { other_id: recipient_id }).then(({ data, error }) => ({ count: Number(data || 0), error })),
    addTransferDelivery: (row) => sb.from('mf_transfer_deliveries').insert(row),
    incomingTransfers: () => sb.from('mf_transfer_deliveries').select('*').eq('recipient_id', state.me.id)
        .or(`recipient_device_id.eq.${state.deviceId},recipient_device_id.is.null`).gt('expires_at', new Date().toISOString()).order('created_at'),
    delTransferDelivery: (id) => sb.from('mf_transfer_deliveries').delete().eq('id', id),

    // ---- messages (async E2E chat; rows are deleted once the recipient decrypts) ----
    // A week's TTL bounds undelivered ciphertext: fresher than that is picked up here,
    // anything older is swept below. Keep MSG_TTL in sync with delExpiredMessages.
    sendMessages: (rows) => sb.from('mf_messages').insert(rows),
    sendMessage: (row) => sb.from('mf_messages').insert(row),
    // everything sent to me in the last week that I haven't picked up yet (across all friends)
    myUndelivered: () => sb.from('mf_messages').select('*').eq('recipient_id', state.me.id).or(`recipient_device_id.eq.${state.deviceId},recipient_device_id.is.null`)
        .gt('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()).order('created_at'),
    // count of my still-undelivered (unexpired) messages to one recipient — the per-recipient offline cap
    pendingMessagesTo: (recipient_id) => sb.from('mf_messages').select('id', { count: 'exact', head: true })
        .eq('sender_id', state.me.id).eq('recipient_id', recipient_id)
        .gt('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()),
    delMessage: (id) => sb.from('mf_messages').delete().eq('id', id),
    // undelivered messages I'm party to that are older than a week — GC'd on boot (RLS scopes to me)
    delExpiredMessages: () => sb.from('mf_messages').delete()
        .lt('created_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()),

    // ---- streaks (atomic bump via SECURITY DEFINER fn; canonicalizes the pair) ----
    bumpStreak: (other) => sb.rpc('mf_bump_streak', { other }),
    streaks: () => sb.from('mf_streaks').select('*')
        .or(`user_a.eq.${state.me.id},user_b.eq.${state.me.id}`).gt('count', 0),

    // ---- web push (1:1 messages + calls) ----
    // Subscriptions are keyed by browser endpoint; the Edge Function reads them (service role)
    // to send "you have something" pushes. Content never leaves the client.
    claimPushSub: (sub) => sb.rpc('mf_claim_push_subscription', { push_endpoint: sub.endpoint, push_p256dh: sub.p256dh, push_auth: sub.auth }),
    releasePushSub: (endpoint) => sb.rpc('mf_release_push_subscription', { push_endpoint: endpoint }),
    hasPushSub: (endpoint) => sb.from('mf_push_subscriptions').select('id', { count: 'exact', head: true }).eq('endpoint', endpoint),
    // a 1:1 call has no DB row of its own; this transient row is only a push trigger
    ringCall: (callee_id, kind) => sb.from('mf_call_rings').insert({ caller_id: state.me.id, callee_id, kind }).select('id').maybeSingle(),
    delRing: (id) => sb.from('mf_call_rings').delete().eq('id', id),
    // sweep any of my ring rows older than a couple minutes (call already over) — boot GC
    delMyStaleRings: () => sb.from('mf_call_rings').delete()
        .eq('caller_id', state.me.id).lt('created_at', new Date(Date.now() - 2 * 60 * 1000).toISOString()),

    // ---- stories (24h, friends-only; RLS returns mine + friends' automatically) ----
    addStory: ({ id, preview, caption, w, h }) => sb.rpc('mf_add_story', {
        story_id: id, story_preview: preview, story_caption: caption, story_w: w, story_h: h,
    }),
    activeStories: () => sb.from('mf_stories').select('*, author:user_id(' + PROF + ')')
        .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: true }),
    storyById: (id) => sb.from('mf_stories').select('id, preview, caption, w, h').eq('id', id).maybeSingle(),
    // Keep only active rows when reconciling device-only full images. Expired stories
    // stay invisible even before a server-side cleanup job removes their metadata.
    myStories: () => sb.from('mf_stories').select('id').eq('user_id', state.me.id)
        .gt('expires_at', new Date().toISOString()),
    delStory: (id) => sb.from('mf_stories').delete().eq('id', id),
    viewStory: (story_id) => sb.from('mf_story_views').upsert({ story_id, viewer_id: state.me.id }, { onConflict: 'story_id,viewer_id', ignoreDuplicates: true }),
    myViewedStories: () => sb.from('mf_story_views').select('story_id').eq('viewer_id', state.me.id),
    storyViewers: (story_id) => sb.from('mf_story_views')
        .select('viewed_at, viewer:viewer_id(' + PROF + ')').eq('story_id', story_id).order('viewed_at', { ascending: false }),

    // ---- groups (persistent named group chats + mesh calls) ----
    createGroup: async (name, memberIds) => {
        const { data: g, error } = await sb.from('mf_groups').insert({ name, created_by: state.me.id }).select().single();
        if (error) return { error };
        const rows = [...new Set([state.me.id, ...memberIds])].map(uid => ({ group_id: g.id, user_id: uid }));
        const { error: e2 } = await sb.from('mf_group_members').insert(rows);
        return { data: g, error: e2 };
    },
    myGroups: () => sb.from('mf_groups')
        .select('*, mf_group_members(user_id, profiles:mf_profiles!mf_group_members_user_id_fkey(username, avatar))')
        .order('created_at', { ascending: false }),
    groupById: (gid) => sb.from('mf_groups')
        .select('*, mf_group_members(user_id, profiles:mf_profiles!mf_group_members_user_id_fkey(username, avatar))').eq('id', gid).single(),
    renameGroup: (gid, name) => sb.rpc('mf_rename_group', { gid, new_name: name }),
    removeGroupMember: (gid, uid) => sb.rpc('mf_remove_group_member', { gid, target_uid: uid }),
    addGroupMember: (gid, uid) => sb.from('mf_group_members').insert({ group_id: gid, user_id: uid }),
    leaveGroup: (gid) => sb.from('mf_group_members').delete().match({ group_id: gid, user_id: state.me.id }),
};

export { db };
