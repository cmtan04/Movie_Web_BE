// Direct API call without the HF library
async function getEmbeddings(texts) {
    try {
        const response = await fetch('https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ inputs: texts }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Error:', error.message);
        throw error;
    }
}

// Test
try {
    const result = await getEmbeddings("Hello World");
    console.log('Dimensions:', result.length);
    console.log('First 5 values:', result.slice(0, 5));
} catch (error) {
    console.error('Failed:', error.message);
}