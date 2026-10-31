import type { TaskRecipeView } from '@mimi/shared';
import { developerRecipe } from './developer.ts';
import { fileOrganizerRecipe } from './file-organizer.ts';
import { photoCullRecipe } from './photo-cull.ts';
import { youtubeUploadRecipe } from './youtube-upload.ts';
import type { TaskRecipe } from './types.ts';

/** The recipes this build knows how to run. */
export class RecipeRegistry {
  private readonly recipes = new Map<string, TaskRecipe<any>>();

  register<Input>(recipe: TaskRecipe<Input>): this {
    if (this.recipes.has(recipe.name)) throw new Error(`Task recipe "${recipe.name}" is already registered.`);
    this.recipes.set(recipe.name, recipe);
    return this;
  }

  get(name: string): TaskRecipe<any> | undefined {
    return this.recipes.get(name);
  }

  names(): string[] {
    return [...this.recipes.keys()];
  }

  list(): TaskRecipeView[] {
    return [...this.recipes.values()].map((recipe) => ({
      name: recipe.name,
      description: recipe.description,
      level: recipe.level,
      interfaces: recipe.interfaces,
    }));
  }
}

export function createDefaultRecipes(): RecipeRegistry {
  return new RecipeRegistry()
    .register(fileOrganizerRecipe)
    .register(developerRecipe)
    .register(photoCullRecipe)
    .register(youtubeUploadRecipe);
}
