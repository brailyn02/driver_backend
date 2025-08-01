const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// MongoDB Atlas Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Driver Data Schema - SAFE/DANGER Only
const driverSchema = new mongoose.Schema({
  driverId: {
    type: String,
    required: true,
    index: true
  },
  latitude: {
    type: Number,
    required: true,
    min: -90,
    max: 90
  },
  longitude: {
    type: Number,
    required: true,
    min: -180,
    max: 180
  },
  status: {
    type: String,
    required: true,
    enum: ['SAFE', 'DANGER'],  // ✅ Only 2 states
    default: 'SAFE'
  },
  detailedStatus: {
    type: String,
    default: null
  },
  recommendedAction: {
    type: String,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  rawSms: {
    type: String,
    default: null
  }
});

// Create compound index for efficient queries
driverSchema.index({ driverId: 1, timestamp: -1 });

const Driver = mongoose.model('Driver', driverSchema);

// WebSocket Server
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Store active WebSocket connections
const activeConnections = new Set();

wss.on('connection', (ws) => {
  console.log('📱 New WebSocket connection established');
  activeConnections.add(ws);
  
  // Send current driver data to new connection
  Driver.aggregate([
    {
      $group: {
        _id: '$driverId',
        latestData: { $last: '$$ROOT' }
      }
    },
    {
      $replaceRoot: { newRoot: '$latestData' }
    },
    {
      $sort: { timestamp: -1 }
    }
  ]).then(drivers => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'initial_data',
        drivers: drivers
      }));
    }
  }).catch(err => console.error('Error fetching initial data:', err));

  ws.on('close', () => {
    console.log('📱 WebSocket connection closed');
    activeConnections.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    activeConnections.delete(ws);
  });
});

// Function to broadcast updates to all connected clients
function broadcastUpdate(driverData) {
  const message = JSON.stringify({
    type: 'driver_update',
    data: driverData
  });

  activeConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
      } catch (error) {
        console.error('Error sending WebSocket message:', error);
        activeConnections.delete(ws);
      }
    } else {
      activeConnections.delete(ws);
    }
  });
}

// SMS Parser Function - SAFE/DANGER Only
function parseSmsData(smsText) {
  try {
    const data = {};
    
    // Remove any extra whitespace and split by comma
    const parts = smsText.trim().split(',');
    
    parts.forEach(part => {
      const [key, value] = part.split(':').map(s => s.trim());
      if (key && value) {
        switch (key.toLowerCase()) {
          case 'id':
            data.driverId = value;
            break;
          case 'lat':
          case 'latitude':
            data.latitude = parseFloat(value);
            break;
          case 'lng':
          case 'lon':
          case 'longitude':
            data.longitude = parseFloat(value);
            break;
          case 'status':
          case 'state':
            // ✅ Only allow SAFE or DANGER
            const statusValue = value.toUpperCase();
            if (statusValue === 'SAFE' || statusValue === 'DANGER') {
              data.status = statusValue;
            } else {
              data.status = 'SAFE'; // Default to SAFE for unknown statuses
            }
            break;
          case 'detail':
          case 'detailed':
          case 'detailedstatus':
            data.detailedStatus = value;
            break;
          case 'action':
          case 'recommendation':
          case 'recommendedaction':
            data.recommendedAction = value;
            break;
          default:
            // Store unknown fields in detailedStatus
            if (!data.detailedStatus) {
              data.detailedStatus = `${key}:${value}`;
            } else {
              data.detailedStatus += ` | ${key}:${value}`;
            }
        }
      }
    });
    
    return data;
  } catch (error) {
    console.error('Error parsing SMS data:', error);
    return null;
  }
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connections: activeConnections.size,
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Receive SMS data from Android app
app.post('/api/sms/receive', async (req, res) => {
  try {
    const { smsText, phoneNumber, timestamp } = req.body;
    
    if (!smsText) {
      return res.status(400).json({ error: 'SMS text is required' });
    }
    
    console.log('📱 Received SMS:', smsText);
    
    // Parse SMS data
    const parsedData = parseSmsData(smsText);
    
    if (!parsedData || !parsedData.driverId) {
      return res.status(400).json({ error: 'Invalid SMS format or missing driver ID' });
    }
    
    // Validate required fields
    if (!parsedData.latitude || !parsedData.longitude) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }
    
    // Create driver data object
    const driverData = {
      driverId: parsedData.driverId,
      latitude: parsedData.latitude,
      longitude: parsedData.longitude,
      status: parsedData.status || 'SAFE',  // ✅ Default to SAFE
      detailedStatus: parsedData.detailedStatus || null,
      recommendedAction: parsedData.recommendedAction || null,
      rawSms: smsText,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    };
    
    // Save to database
    const driver = new Driver(driverData);
    await driver.save();
    
    console.log('✅ Driver data saved:', {
      id: driverData.driverId,
      status: driverData.status,
      location: `${driverData.latitude}, ${driverData.longitude}`
    });
    
    // Broadcast update to all connected clients
    broadcastUpdate(driverData);
    
    // Send emergency alert if status is DANGER
    if (driverData.status === 'DANGER') {
      console.log('🚨 DANGER ALERT:', driverData.driverId);
      // Here you could add additional emergency notification logic
      // e.g., send push notifications, emails, etc.
    }
    
    res.json({
      success: true,
      message: 'SMS data processed successfully',
      driverId: driverData.driverId,
      status: driverData.status,
      timestamp: driverData.timestamp
    });
    
  } catch (error) {
    console.error('Error processing SMS:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all drivers with their latest data
app.get('/api/drivers', async (req, res) => {
  try {
    const drivers = await Driver.aggregate([
      {
        $group: {
          _id: '$driverId',
          latestData: { $last: '$$ROOT' }
        }
      },
      {
        $replaceRoot: { newRoot: '$latestData' }
      },
      {
        $sort: { timestamp: -1 }
      }
    ]);
    
    res.json(drivers);
  } catch (error) {
    console.error('Error fetching drivers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific driver history
app.get('/api/drivers/:driverId/history', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { limit = 50, hours = 24 } = req.query;
    
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    const history = await Driver.find({
      driverId: driverId,
      timestamp: { $gte: startTime }
    })
    .sort({ timestamp: -1 })
    .limit(parseInt(limit));
    
    res.json(history);
  } catch (error) {
    console.error('Error fetching driver history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get SAFE drivers only
app.get('/api/drivers/safe', async (req, res) => {
  try {
    const drivers = await Driver.aggregate([
      {
        $group: {
          _id: '$driverId',
          latestData: { $last: '$$ROOT' }
        }
      },
      {
        $replaceRoot: { newRoot: '$latestData' }
      },
      {
        $match: { status: 'SAFE' }
      },
      {
        $sort: { timestamp: -1 }
      }
    ]);
    
    res.json(drivers);
  } catch (error) {
    console.error('Error fetching safe drivers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get DANGER drivers only
app.get('/api/drivers/danger', async (req, res) => {
  try {
    const drivers = await Driver.aggregate([
      {
        $group: {
          _id: '$driverId',
          latestData: { $last: '$$ROOT' }
        }
      },
      {
        $replaceRoot: { newRoot: '$latestData' }
      },
      {
        $match: { status: 'DANGER' }
      },
      {
        $sort: { timestamp: -1 }
      }
    ]);
    
    res.json(drivers);
  } catch (error) {
    console.error('Error fetching danger drivers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
  console.log(`🔗 API endpoints available at http://localhost:${PORT}/api/`);
  console.log(`✅ Driver status: SAFE or DANGER only`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});