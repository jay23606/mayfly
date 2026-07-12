import { sb, state } from './core.js';

// ===================== data access (all mf_-prefixed) =====================
const PROF = 'id, username, avatar, pubkey';
const db = {
    // ---- profiles ----
    myProfile: () => sb.from('mf_profiles').select('*').eq('id', state.me.id).maybeSingle(),
    profile:   (username) => sb.from('mf_profiles').select('*').eq('username', username).maybeSingle(),
    profileById: (id) => sb.from('mf_profiles').select(PROF).eq('id', id).maybeSingle(),
    updateProfile: (patch) => sb.from('mf_profiles').update(patch).eq('id', state.me.id),
    upsertProfile: (row) => sb.from('mf_profiles').upsert({ id: state.me.id, ...row }).select().maybeSingle(),
    searchProfiles: (q) => sb.from('mf_profiles').select(PROF).ilike('username', `%${q}%`).neq('id', state.me.id).limit(50),
    allProfiles: () => sb.from('mf_profiles').select(PROF).neq('id', state.me.id).order('created_at', { ascending: false }).limit(50),

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
        .eq('recipient_id', state.me.id).is('viewed_at', null)
        .order('created_at', { ascending: false }),
    // pending (unopened) relay snaps I've sent to one recipient — for the offline cap
    pendingRelayTo: (recipient_id) => sb.from('mf_snaps')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', state.me.id).eq('recipient_id', recipient_id)
        .like('delivery', 'relay%').is('viewed_at', null),
    addSnap: (row) => sb.from('mf_snaps').insert(row).select().maybeSingle(),
    delSnap: (id) => sb.from('mf_snaps').delete().eq('id', id),
    // snaps I sent that have now been opened / expired → clean up my device copies
    mySpentSnaps: () => sb.from('mf_snaps').select('id').eq('sender_id', state.me.id),

    // ---- messages (async E2E chat; rows are deleted once the recipient decrypts) ----
    sendMessage: (row) => sb.from('mf_messages').insert(row),
    // everything sent to me that I haven't picked up yet (across all friends)
    myUndelivered: () => sb.from('mf_messages').select('*').eq('recipient_id', state.me.id).order('created_at'),
    delMessage: (id) => sb.from('mf_messages').delete().eq('id', id),

    // ---- streaks (atomic bump via SECURITY DEFINER fn; canonicalizes the pair) ----
    bumpStreak: (other) => sb.rpc('mf_bump_streak', { other }),
    streaks: () => sb.from('mf_streaks').select('*')
        .or(`user_a.eq.${state.me.id},user_b.eq.${state.me.id}`).gt('count', 0),

    // ---- stories (24h, friends-only; RLS returns mine + friends' automatically) ----
    addStory: ({ id, preview, caption, w, h }) => sb.rpc('mf_add_story', {
        story_id: id, story_preview: preview, story_caption: caption, story_w: w, story_h: h,
    }),
    activeStories: () => sb.from('mf_stories').select('*, author:user_id(' + PROF + ')')
        .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: true }),
    // Keep only active rows when reconciling device-only full images. Expired stories
    // stay invisible even before a server-side cleanup job removes their metadata.
    myStories: () => sb.from('mf_stories').select('id').eq('user_id', state.me.id)
        .gt('expires_at', new Date().toISOString()),
    delStory: (id) => sb.from('mf_stories').delete().eq('id', id),
    viewStory: (story_id) => sb.from('mf_story_views').upsert({ story_id, viewer_id: state.me.id }),
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
