import type { AssignedIssue, Comment, Issue } from "../types.js";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export const PRIORITY_MAP: Record<number, string> = {
	0: "No priority",
	1: "Urgent",
	2: "High",
	3: "Medium",
	4: "Low",
};

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

export async function fetchAssignedIssues(accessToken: string): Promise<AssignedIssue[] | null> {
	const data = (await graphqlQuery(ASSIGNED_ISSUES_QUERY, {}, accessToken)) as {
		viewer?: { assignedIssues?: { nodes?: LinearIssueNode[] } };
	} | null;
	const nodes = data?.viewer?.assignedIssues?.nodes;
	if (!nodes) return null;
	return nodes.map(mapAssigned);
}
