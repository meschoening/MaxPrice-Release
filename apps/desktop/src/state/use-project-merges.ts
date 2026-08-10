import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import {
  PROJECT_MERGE_PATH,
  projectMergeMutationResponseSchema,
  type ProjectMergeMutationRequest,
  type ProjectMergeMutationResponse,
} from "@maxprice/shared";
import { sidecarFetch } from "@/lib/sidecar";
import { usageAuthHeaders } from "@/lib/usage-credential";
import { projectIdentityQueryKey } from "./use-project-identity";

export function buildProjectMergeUrl(): string {
  return PROJECT_MERGE_PATH;
}

export async function postProjectMerge(
  request: ProjectMergeMutationRequest,
  fetchImpl: typeof sidecarFetch = sidecarFetch,
): Promise<ProjectMergeMutationResponse> {
  const headers = await usageAuthHeaders();
  const res = await fetchImpl(buildProjectMergeUrl(), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        const error = (parsed as { error: unknown }).error;
        if (typeof error === "string" && error !== "") message = error;
      }
    } catch {
      // Raw response text remains the fallback.
    }
    throw new Error(message || `${PROJECT_MERGE_PATH} ${res.status}`);
  }
  return projectMergeMutationResponseSchema.parse(await res.json());
}

export function useProjectMerge(): UseMutationResult<
  ProjectMergeMutationResponse,
  Error,
  ProjectMergeMutationRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) => postProjectMerge(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectIdentityQueryKey }),
  });
}
