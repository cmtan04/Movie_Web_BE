import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import client from './mongoDB.config.js';

dotenv.config();

const DB_NAME = 'movie_bot';
const COLLECTION_NAME = 'movies';
const INDEX_NAME = 'movies_embedding_index';
const DIMENSIONS = 384; // SentenceTransformer paraphrase-multilingual-MiniLM-L12-v2

async function createVectorIndex() {
  try {
    await client.connect();
    console.log('✓ Connected to MongoDB');

    const db = client.db(DB_NAME);

    // Check existing search indexes (MongoDB 7+/Atlas supports listSearchIndexes)
    try {
      const list = await db.command({
        listSearchIndexes: COLLECTION_NAME,
      });
      const exists = Array.isArray(list.indexes)
        && list.indexes.some((idx) => idx.name === INDEX_NAME);
      if (exists) {
        console.log(`ℹ️ Search index "${INDEX_NAME}" already exists. Skipping creation.`);
        return;
      }
    } catch (e) {
      console.log('ℹ️ Unable to list search indexes; will attempt creation directly.');
    }

    const createResult = await db.command({
      createSearchIndexes: COLLECTION_NAME,
      indexes: [
        {
          name: INDEX_NAME,
          definition: {
            mappings: {
              dynamic: true,
              fields: {
                embedding: {
                  type: 'knnVector',
                  dimensions: DIMENSIONS,
                  similarity: 'cosine',
                },
              },
            },
          },
        },
      ],
    });

    console.log('✓ Vector Search index created:', JSON.stringify(createResult));
  } catch (err) {
    console.error('❌ Failed to create vector index:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
    console.log('✓ MongoDB connection closed');
  }
}

createVectorIndex();
