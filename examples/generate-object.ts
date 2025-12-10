/**
 * Object Generation example for the OpenCode AI SDK provider.
 *
 * This example demonstrates:
 * - Using generateObject() for structured output
 * - Zod schema validation
 * - Different schema patterns (primitives, arrays, nested objects)
 *
 * Note: OpenCode uses prompt engineering for JSON mode, not native
 * structured output. The AI SDK handles schema validation.
 */

import { generateObject } from 'ai';
import { createOpencode } from '../dist/index.js';
import { z } from 'zod';

async function main() {
  const opencode = createOpencode({
    autoStartServer: true,
  });

  try {
    console.log('=== OpenCode: Object Generation Examples ===\n');

    // Example 1: Simple object with primitives
    console.log('1. Simple Object with Primitives\n');

    const { object: profile } = await generateObject({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      schema: z.object({
        name: z.string().describe('Full name of the person'),
        age: z.number().describe('Age in years'),
        email: z.string().email().describe('Valid email address'),
        isActive: z.boolean().describe('Whether the account is active'),
      }),
      prompt: 'Generate a profile for a software developer named Alex.',
    });

    console.log('Generated profile:');
    console.log(JSON.stringify(profile, null, 2));
    console.log();

    // Example 2: Object with arrays
    console.log('2. Object with Arrays\n');

    const { object: team } = await generateObject({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      schema: z.object({
        teamName: z.string().describe('Name of the development team'),
        members: z.array(z.string()).describe('List of team member names'),
        technologies: z.array(z.string()).describe('Technologies used by the team'),
        projectCount: z.number().describe('Number of active projects'),
      }),
      prompt: 'Generate data for a backend development team working on API services.',
    });

    console.log('Generated team:');
    console.log(JSON.stringify(team, null, 2));
    console.log();

    // Example 3: Nested objects
    console.log('3. Nested Objects\n');

    const { object: company } = await generateObject({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      schema: z.object({
        name: z.string().describe('Company name'),
        founded: z.number().describe('Year founded'),
        headquarters: z.object({
          city: z.string().describe('City name'),
          country: z.string().describe('Country name'),
        }),
        departments: z.array(
          z.object({
            name: z.string().describe('Department name'),
            headCount: z.number().describe('Number of employees'),
          })
        ),
      }),
      prompt: 'Generate data for a mid-size tech startup.',
    });

    console.log('Generated company:');
    console.log(JSON.stringify(company, null, 2));
    console.log();

    // Example 4: Optional fields and enums
    console.log('4. Optional Fields and Enums\n');

    const { object: task } = await generateObject({
      model: opencode('anthropic/claude-opus-4-5-20251101'),
      schema: z.object({
        title: z.string().describe('Task title'),
        description: z.string().describe('Task description'),
        priority: z.enum(['low', 'medium', 'high', 'critical']).describe('Task priority'),
        assignee: z.string().optional().describe('Assigned team member'),
        dueDate: z.string().optional().describe('Due date in ISO format'),
        tags: z.array(z.string()).optional().describe('Task tags'),
        estimatedHours: z.number().optional().describe('Estimated hours to complete'),
      }),
      prompt: 'Generate a high-priority bug fix task for a login issue.',
    });

    console.log('Generated task:');
    console.log(JSON.stringify(task, null, 2));
    console.log();

    console.log('All examples completed successfully!');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await opencode.dispose?.();
  }
}

main().catch(console.error);
