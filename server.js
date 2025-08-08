require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to calculate days between dates
function calculateDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays); // At least 1 day
}

// Helper function to determine season
function getSeason(date, location) {
  const month = new Date(date).getMonth(); // 0-11
  const isNorthernHemisphere = !location.toLowerCase().includes('australia') && 
                              !location.toLowerCase().includes('new zealand') && 
                              !location.toLowerCase().includes('chile') && 
                              !location.toLowerCase().includes('argentina') &&
                              !location.toLowerCase().includes('south africa');

  if (isNorthernHemisphere) {
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'fall';
    return 'winter';
  } else {
    // Southern hemisphere - seasons are opposite
    if (month >= 2 && month <= 4) return 'fall';
    if (month >= 5 && month <= 7) return 'winter';
    if (month >= 8 && month <= 10) return 'spring';
    return 'summer';
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'itinerary-generator-microservice',
    version: '1.0.0'
  });
});

// Main itinerary generation endpoint
app.post('/generate-itinerary', async (req, res) => {
  try {
    const { location, startDate, endDate } = req.body;
    
    // Validation
    if (!location || !startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: location, startDate, and endDate are required' 
      });
    }

    // Calculate trip duration and season
    const tripDays = calculateDays(startDate, endDate);
    const season = getSeason(startDate, location);
    const startDateObj = new Date(startDate);
    const monthName = startDateObj.toLocaleString('default', { month: 'long' });

    console.log(`Generating itinerary for ${location}, ${tripDays} days in ${season} (${monthName})`);

    // Build comprehensive prompt for Gemini
    const prompt = `
      Generate ${Math.min(tripDays + 2, 10)} activity suggestions for a trip to ${location} during ${season} (${monthName}).
      
      Trip details:
      - Duration: ${tripDays} days
      - Season: ${season}
      - Location: ${location}
      
      Please provide diverse activities that are:
      1. Seasonally appropriate for ${season} weather
      2. Popular attractions and experiences in ${location}
      3. Mix of indoor/outdoor activities suitable for ${season}
      4. Include cultural, recreational, and dining experiences
      5. Consider local events or seasonal attractions for ${monthName}
      
      Format as a JSON array with this exact structure:
      [
        {
          "activity": "Activity name",
          "description": "Brief description (2-3 sentences)",
          "category": "Cultural|Recreation|Dining|Nature|Entertainment|Shopping",
          "seasonalNote": "Why this is good for ${season}"
        }
      ]
      
      Return only valid JSON, no additional text.
    `;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Add timeout for AI request
    const aiPromise = model.generateContent(prompt);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('AI request timeout')), 15000)
    );

    const result = await Promise.race([aiPromise, timeoutPromise]);
    const response = await result.response;
    const text = response.text();

    // Parse the AI response
    let activities = [];
    try {
      // Try to extract JSON array from the response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        activities = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON array found in response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      console.error('AI Response:', text);
      
      // Fallback activities based on location and season
      activities = generateFallbackActivities(location, season, tripDays);
    }

    // Validate and clean activities
    if (!Array.isArray(activities) || activities.length === 0) {
      activities = generateFallbackActivities(location, season, tripDays);
    }

    // Ensure each activity has required fields
    activities = activities.map((activity, index) => ({
      activity: activity.activity || `Activity ${index + 1}`,
      description: activity.description || 'Explore this popular local attraction.',
      category: activity.category || 'Recreation',
      seasonalNote: activity.seasonalNote || `Perfect for ${season} travel.`
    }));

    // Limit to reasonable number of suggestions
    activities = activities.slice(0, Math.min(tripDays + 2, 10));

    const responseData = {
      success: true,
      location: location,
      startDate: startDate,
      endDate: endDate,
      tripDays: tripDays,
      season: season,
      activities: activities,
      generatedAt: new Date().toISOString()
    };

    console.log(`Successfully generated ${activities.length} activities for ${location}`);
    res.json(responseData);

  } catch (error) {
    console.error('Error generating itinerary:', error);
    
    // Return fallback response even on error
    const fallbackActivities = generateFallbackActivities(
      req.body.location || 'your destination', 
      getSeason(req.body.startDate || new Date().toISOString(), req.body.location || ''), 
      calculateDays(req.body.startDate || new Date().toISOString(), req.body.endDate || new Date().toISOString())
    );

    res.status(500).json({
      success: false,
      error: 'Failed to generate itinerary suggestions',
      details: error.message,
      fallbackActivities: fallbackActivities
    });
  }
});

// Fallback activity generator
function generateFallbackActivities(location, season, tripDays) {
  const fallbackActivities = [
    {
      activity: "Explore Local Museums",
      description: "Visit popular museums and cultural sites to learn about local history and art.",
      category: "Cultural",
      seasonalNote: `Indoor activities are great year-round, especially during ${season}.`
    },
    {
      activity: "Try Local Cuisine",
      description: "Experience authentic local restaurants and try regional specialties.",
      category: "Dining",
      seasonalNote: `Seasonal ingredients make ${season} dining experiences unique.`
    },
    {
      activity: "Walking Tour",
      description: "Take a guided or self-guided tour of the main attractions and historic areas.",
      category: "Cultural",
      seasonalNote: `${season} weather makes for pleasant walking conditions.`
    },
    {
      activity: "Local Markets",
      description: "Browse local markets for souvenirs, crafts, and fresh local products.",
      category: "Shopping",
      seasonalNote: `Markets often feature seasonal products during ${season}.`
    },
    {
      activity: "Parks and Gardens",
      description: "Relax in local parks and botanical gardens, enjoying nature and outdoor spaces.",
      category: "Nature",
      seasonalNote: `${season} is a beautiful time to enjoy outdoor green spaces.`
    }
  ];

  return fallbackActivities.slice(0, Math.min(tripDays + 2, 5));
}

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Itinerary Generator Microservice',
    version: '1.0.0',
    endpoints: {
      generate: 'POST /generate-itinerary',
      health: 'GET /health'
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Itinerary Generator Microservice running on port ${PORT}`);
  console.log(`Gemini AI configured: ${!!process.env.GEMINI_API_KEY}`);
});