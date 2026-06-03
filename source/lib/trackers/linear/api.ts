import type { AssignedIssue, Comment, Issue, TriageSchedule, TriageShift } from "../types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export const PRIORITY_MAP: Record<number, string> = {
	0: "No priority",
	1: "Urgent",
	2: "High",
	3: "Medium",
	4: "Low",
};

// Workflow states whose issues should never appear in the assigned-work list,
// matched by name (case-insensitive) regardless of their configured `type`.
// Linear ships a default "Duplicate" state, but workspaces sometimes type it
// as non-terminal (backlog/unstarted) rather than `canceled`, so it slips past
// the query's `type: { nin: ["completed", "canceled"] }` filter and clutters
// the backlog. These are resolution states — hide them everywhere.
const HIDDEN_STATE_NAMES = new Set(["duplicate"]);

async function graphqlQuery(
	query: string,
	variables: Record<string, unknown>,
	accessToken: string,
): Promise<unknown> {
	const res = await fetch(LINEAR_GRAPHQL_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!res.ok) return null;

	const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
	if (json.errors) {
		console.error("Linear GraphQL errors:", JSON.stringify(json.errors, null, 2));
	}
	return json.data ?? null;
}

const ISSUE_QUERY = `
query GetIssue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    dueDate
    state { name type }
    priority
    labels { nodes { name } }
    project { id name }
    comments {
      nodes {
        body
        createdAt
        parent { id }
        user { displayName }
        children {
          nodes {
            body
            createdAt
            user { displayName }
          }
        }
      }
    }
  }
}
`;

const ASSIGNED_ISSUES_QUERY = `
query AssignedIssues {
  viewer {
    assignedIssues(
      filter: { state: { type: { nin: ["completed", "canceled"] } } }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        description
        url
        dueDate
        priority
        state { name type }
        labels { nodes { name } }
        project { id name }
      }
    }
  }
}
`;

interface LinearStateNode {
	name?: string;
	type?: string;
}

interface LinearLabelNode {
	name: string;
}

interface LinearCommentNode {
	body: string;
	createdAt: string;
	parent?: { id: string } | null;
	user?: { displayName?: string };
	children?: { nodes?: LinearCommentNode[] };
}

interface LinearIssueNode {
	identifier: string;
	title: string;
	description?: string | null;
	url: string;
	dueDate?: string | null;
	priority: number;
	state?: LinearStateNode;
	labels?: { nodes?: LinearLabelNode[] };
	project?: { id?: string; name?: string } | null;
	comments?: { nodes?: LinearCommentNode[] };
}

function mapAssigned(issue: LinearIssueNode): AssignedIssue {
	return {
		identifier: issue.identifier,
		title: issue.title,
		description: issue.description ?? null,
		url: issue.url,
		dueDate: issue.dueDate ?? null,
		priority: issue.priority,
		priorityLabel: PRIORITY_MAP[issue.priority] ?? "No priority",
		state: {
			name: issue.state?.name ?? "Unknown",
			type: issue.state?.type ?? "unstarted",
		},
		labels: (issue.labels?.nodes ?? []).map((l) => l.name),
		projectId: issue.project?.id ?? null,
		projectName: issue.project?.name ?? null,
	};
}

function mapComments(nodes: LinearCommentNode[]): Comment[] {
	return nodes
		.filter((c) => !c.parent)
		.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
		.map((c) => ({
			author: c.user?.displayName ?? "Unknown",
			body: c.body,
			createdAt: c.createdAt,
			children: (c.children?.nodes ?? [])
				.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
				.map((r) => ({
					author: r.user?.displayName ?? "Unknown",
					body: r.body,
					createdAt: r.createdAt,
					children: [],
				})),
		}));
}

export async function fetchIssue(ticketId: string, accessToken: string): Promise<Issue | null> {
	const data = (await graphqlQuery(ISSUE_QUERY, { id: ticketId }, accessToken)) as {
		issue?: LinearIssueNode;
	} | null;
	if (!data?.issue) return null;
	const base = mapAssigned(data.issue);
	return {
		...base,
		comments: mapComments(data.issue.comments?.nodes ?? []),
	};
}

// ── Triage on-call schedules ──────────────────────────────────────────
// Linear's "Triage responsibility" can be backed by a time schedule (a weekly
// on-call rotation). We surface the schedules for the teams the viewer belongs
// to. Schedule entries reference users by id only, so a follow-up `users`
// lookup resolves display names.

const TRIAGE_SCHEDULES_QUERY = `
query TriageSchedules {
  viewer {
    id
    teamMemberships(first: 100) {
      nodes {
        team {
          key
          name
          triageResponsibility {
            currentUser { id }
            timeSchedule {
              name
              entries { startsAt endsAt userId userEmail }
            }
          }
        }
      }
    }
  }
}
`;

interface LinearScheduleEntry {
	startsAt: string;
	endsAt: string;
	userId?: string | null;
	userEmail?: string | null;
}

interface LinearTeamTriageNode {
	key: string;
	name: string;
	triageResponsibility?: {
		currentUser?: { id?: string } | null;
		timeSchedule?: { name?: string; entries?: LinearScheduleEntry[] } | null;
	} | null;
}

/** Resolve user ids → display names via a single `users` query. */
async function resolveUserNames(
	ids: string[],
	accessToken: string,
): Promise<Record<string, string>> {
	if (ids.length === 0) return {};
	const query = `query ResolveUsers($ids: [ID!]!) {
		users(filter: { id: { in: $ids } }, first: 250) { nodes { id displayName } }
	}`;
	const data = (await graphqlQuery(query, { ids }, accessToken)) as {
		users?: { nodes?: { id: string; displayName: string }[] };
	} | null;
	const map: Record<string, string> = {};
	for (const u of data?.users?.nodes ?? []) map[u.id] = u.displayName;
	return map;
}

export async function fetchTriageSchedules(accessToken: string): Promise<TriageSchedule[]> {
	const data = (await graphqlQuery(TRIAGE_SCHEDULES_QUERY, {}, accessToken)) as {
		viewer?: { id?: string; teamMemberships?: { nodes?: { team?: LinearTeamTriageNode }[] } };
	} | null;
	const viewerId = data?.viewer?.id ?? null;
	const memberships = data?.viewer?.teamMemberships?.nodes ?? [];

	// Keep only teams whose triage responsibility is backed by a time schedule
	// with at least one entry.
	const teams = memberships
		.map((m) => m.team)
		.filter(
			(t): t is LinearTeamTriageNode =>
				!!t && (t.triageResponsibility?.timeSchedule?.entries?.length ?? 0) > 0,
		);
	if (teams.length === 0) return [];

	// Resolve every referenced user id in one batch.
	const ids = new Set<string>();
	for (const t of teams) {
		const tr = t.triageResponsibility!;
		if (tr.currentUser?.id) ids.add(tr.currentUser.id);
		for (const e of tr.timeSchedule?.entries ?? []) if (e.userId) ids.add(e.userId);
	}
	const names = await resolveUserNames([...ids], accessToken);

	const now = Date.now();
	const schedules: TriageSchedule[] = teams.map((t) => {
		const tr = t.triageResponsibility!;
		const shifts: TriageShift[] = (tr.timeSchedule?.entries ?? [])
			.map((e) => {
				const start = Date.parse(e.startsAt);
				const end = Date.parse(e.endsAt);
				return {
					startsAt: e.startsAt,
					endsAt: e.endsAt,
					name: (e.userId && names[e.userId]) || e.userEmail || "Unknown",
					isCurrent: now >= start && now < end,
					isMe: !!viewerId && e.userId === viewerId,
				};
			})
			.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
		const currentShift = shifts.find((s) => s.isCurrent) ?? null;
		const currentUserId = tr.currentUser?.id ?? null;
		const currentName =
			currentShift?.name ?? (currentUserId ? (names[currentUserId] ?? null) : null);
		const currentIsMe = currentShift?.isMe ?? (!!viewerId && currentUserId === viewerId);
		return {
			teamKey: t.key,
			teamName: t.name,
			scheduleName: tr.timeSchedule?.name ?? `${t.key} triage`,
			currentName,
			currentIsMe,
			shifts,
		};
	});

	// Surface schedules the viewer actually participates in first.
	schedules.sort((a, b) => {
		const am = a.shifts.some((s) => s.isMe) ? 0 : 1;
		const bm = b.shifts.some((s) => s.isMe) ? 0 : 1;
		return am - bm;
	});
	return schedules;
}

export async function fetchAssignedIssues(accessToken: string): Promise<AssignedIssue[] | null> {
	const data = (await graphqlQuery(ASSIGNED_ISSUES_QUERY, {}, accessToken)) as {
		viewer?: { assignedIssues?: { nodes?: LinearIssueNode[] } };
	} | null;
	const nodes = data?.viewer?.assignedIssues?.nodes;
	if (!nodes) return null;
	return nodes
		.map(mapAssigned)
		.filter((i) => !HIDDEN_STATE_NAMES.has(i.state.name.trim().toLowerCase()));
}
