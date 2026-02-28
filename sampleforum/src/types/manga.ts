export interface Genre {
  id: string;
  name: string;
  slug: string;
}

export interface MangaAuthor {
  name: string;
  role: 'author' | 'artist' | 'translator';
}

export interface Chapter {
  id: string;
  number: number;
  title?: string;
  createdAt: string;
  pageCount: number;
  pageUrls: string[];
}

export interface Manga {
  id: string;
  title: string;
  slug: string;
  cover: string;
  description: string;
  authors: MangaAuthor[];
  genres: Genre[];
  status: 'ongoing' | 'completed' | 'hiatus';
  chapters: Chapter[];
  totalChapters: number;
  viewCount: number;
  followCount: number;
  updatedAt: string;
  createdAt: string;
  isFeatured?: boolean;
}
