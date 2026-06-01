import { z } from "zod"; 

export const payload = z.object({
    type: z.string(),
    payload: z.object({
        target: z.string(),
        projectId: z.string(),
        deployment: z.object({
            id: z.string(),
            meta: z.object({
                githubCommitMessage: z.string(),
                githubCommitRef: z.string()
            })
        })
    })  
});

export type PayloadType = z.infer<typeof payload>;