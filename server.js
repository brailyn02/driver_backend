const express = require('express');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000; // ✅ Fixed port to match logs

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

// ✅ Fixed MongoDB connection - removed deprecated options
mongoose.connect(process.env.MONGODB_URI)
.then(() => {
  console.log('✅ Connected to MongoDB');
})
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1); // Exit if can't connect to prevent restart loop
});

// ✅ Add MongoDB connection event handlers
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️  MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

// 🆕 UPDATED Driver Data Schema - Added unique constraint for driverId
const driverSchema = new mongoose.Schema({
  driverId: {
    type: String,
    required: true,
    unique: true,  // 🆕 This ensures only one record per driver
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
  },
  // 🆕 Additional fields for tracking
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  updateCount: {
    type: Number,
    default: 1
  }
});

// 🆕 Create unique index for driverId to prevent duplicates at DB level
driverSchema.index({ driverId: 1 }, { unique: true });

// 🆕 Pre-save hook to update lastUpdated
driverSchema.pre('save', function(next) {
  this.lastUpdated = new Date();
  next();
});

const Driver = mongoose.model('Driver', driverSchema);

// WebSocket Server
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Store active WebSocket connections
const activeConnections = new Set();

wss.on('connection', (ws) => {
  console.log('📱 New WebSocket connection established');
  activeConnections.add(ws);
  
  // 🆕 UPDATED: Send current driver data to new connection (no need for aggregation now)
  Driver.find()
    .sort({ timestamp: -1 })
    .then(drivers => {
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

// 🆕 NEW FUNCTION: Upsert driver data (update if exists, create if new)
async function upsertDriverData(driverData) {
  try {
    const result = await Driver.findOneAndUpdate(
      { driverId: driverData.driverId }, // Find by driverId
      {
        $set: {
          latitude: driverData.latitude,
          longitude: driverData.longitude,
          status: driverData.status,
          detailedStatus: driverData.detailedStatus,
          recommendedAction: driverData.recommendedAction,
          rawSms: driverData.rawSms,
          timestamp: driverData.timestamp,
          lastUpdated: new Date()
        },
        $inc: { updateCount: 1 } // Increment update counter
      },
      {
        new: true,        // Return the updated document
        upsert: true,     // Create if doesn't exist
        runValidators: true
      }
    );

    return result;
  } catch (error) {
    console.error('Error upserting driver data:', error);
    throw error;
  }
}

// API Routes

// Health check - ✅ Enhanced
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    connections: activeConnections.size,
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    port: PORT
  });
});

// 🆕 UPDATED: Prevent duplicate SMS data
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
    
    // ✅ Add coordinate validation for Algeria
    if (parsedData.latitude < 18.5 || parsedData.latitude > 38.0 || 
        parsedData.longitude < -9.0 || parsedData.longitude > 12.0) {
      console.log(`⚠️  Invalid coordinates for driver ${parsedData.driverId}: lat=${parsedData.latitude}, lng=${parsedData.longitude}`);
      // You might want to reject invalid coordinates or use default values
      // For now, we'll log the warning but still process the data
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
    
    // 🆕 UPDATED: Use upsert instead of creating new document
    const savedDriver = await upsertDriverData(driverData);
    
    const isNewDriver = savedDriver.updateCount === 1;
    const actionTaken = isNewDriver ? 'created' : 'updated';
    
    console.log(`✅ Driver data ${actionTaken}:`, {
      id: savedDriver.driverId,
      status: savedDriver.status,
      location: `${savedDriver.latitude}, ${savedDriver.longitude}`,
      updateCount: savedDriver.updateCount
    });
    
    // Broadcast update to all connected clients
    broadcastUpdate(savedDriver);
    
    // Send emergency alert if status is DANGER
    if (savedDriver.status === 'DANGER') {
      console.log('🚨 DANGER ALERT:', savedDriver.driverId);
      // Here you could add additional emergency notification logic
      // e.g., send push notifications, emails, etc.
    }
    
    res.json({
      success: true,
      message: `SMS data processed successfully (${actionTaken})`,
      driverId: savedDriver.driverId,
      status: savedDriver.status,
      timestamp: savedDriver.timestamp,
      updateCount: savedDriver.updateCount,
      isNewDriver: isNewDriver
    });
    
  } catch (error) {
    console.error('Error processing SMS:', error);
    
    // Handle duplicate key error specifically
    if (error.code === 11000) {
      console.log('Duplicate key detected, retrying with upsert...');
      // This shouldn't happen with our upsert approach, but just in case
      return res.status(409).json({ error: 'Duplicate driver ID processed simultaneously' });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🆕 UPDATED: Get all drivers (simplified since no duplicates now)
app.get('/api/drivers', async (req, res) => {
  try {
    const drivers = await Driver.find()
      .sort({ timestamp: -1 });
    
    console.log(`✅ Fetched ${drivers.length} drivers (no duplicates)`);
    res.json(drivers);
  } catch (error) {
    console.error('Error fetching drivers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🆕 NEW: Get specific driver current status
app.get('/api/drivers/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    const driver = await Driver.findOne({ driverId });
    
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }
    
    console.log(`✅ Fetched driver ${driverId}`);
    res.json(driver);
  } catch (error) {
    console.error('Error fetching driver:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🆕 NEW: Get driver update history (requires historical data collection)
app.get('/api/drivers/:driverId/history', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { limit = 50, hours = 24 } = req.query;
    
    // Since we now only keep latest data, we'd need a separate history collection
    // For now, return the current driver data
    const driver = await Driver.findOne({ driverId });
    
    if (!driver) {
      return res.status(404).json({ 
        error: 'Driver not found',
        message: 'Historical data not available with current deduplication approach'
      });
    }
    
    console.log(`✅ Fetched current data for driver ${driverId} (history not available)`);
    res.json([driver]); // Return as array for consistency
  } catch (error) {
    console.error('Error fetching driver history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🆕 UPDATED: Get SAFE drivers only (simplified)
app.get('/api/drivers/safe', async (req, res) => {
  try {
    const drivers = await Driver.find({ status: 'SAFE' })
      .sort({ timestamp: -1 });
    
    console.log(`✅ Fetched ${drivers.length} SAFE drivers`);
    res.json(drivers);
  } catch (error) {
    console.error('Error fetching safe drivers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🆕 UPDATED: Get DANGER drivers only (simplified)
app.get('/api/drivers/danger', async (req, res) => {
  try {
    const drivers = await Driver.find({ status: 'DANGER' })
      .sort({ timestamp: -1 });
    
    console.log(`✅ Fetched ${drivers.length} DANGER drivers`);
    res.json(drivers);
  } catch (error) {
    console.error('Error fetching danger drivers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🆕 NEW: Get driver statistics
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await Driver.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgUpdateCount: { $avg: '$updateCount' }
        }
      }
    ]);
    
    const totalDrivers = await Driver.countDocuments();
    
    const result = {
      totalDrivers,
      byStatus: stats.reduce((acc, stat) => {
        acc[stat._id] = {
          count: stat.count,
          avgUpdates: Math.round(stat.avgUpdateCount)
        };
        return acc;
      }, {}),
      timestamp: new Date().toISOString()
    };
    
    console.log('✅ Fetched driver statistics');
    res.json(result);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🆕 NEW: Clean up old duplicates (run once to clean existing data)
app.post('/api/admin/cleanup-duplicates', async (req, res) => {
  try {
    // First, let's see what we have
    const allDrivers = await Driver.find().sort({ driverId: 1, timestamp: -1 });
    
    const duplicateGroups = {};
    allDrivers.forEach(driver => {
      if (!duplicateGroups[driver.driverId]) {
        duplicateGroups[driver.driverId] = [];
      }
      duplicateGroups[driver.driverId].push(driver);
    });
    
    let cleanedCount = 0;
    
    for (const [driverId, drivers] of Object.entries(duplicateGroups)) {
      if (drivers.length > 1) {
        // Keep the latest (first in our sorted array)
        const latest = drivers[0];
        const toDelete = drivers.slice(1);
        
        // Delete the older ones
        await Driver.deleteMany({
          _id: { $in: toDelete.map(d => d._id) }
        });
        
        cleanedCount += toDelete.length;
        console.log(`Cleaned ${toDelete.length} duplicates for driver ${driverId}`);
      }
    }
    
    console.log(`✅ Cleanup completed: removed ${cleanedCount} duplicate records`);
    res.json({
      success: true,
      message: `Cleanup completed`,
      duplicatesRemoved: cleanedCount,
      remainingDrivers: Object.keys(duplicateGroups).length
    });
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// Root route to prevent "Cannot GET /"
app.get('/', (req, res) => {
  res.json({
    message: '🚗 Driver Safety Monitoring Backend (Deduplication Enabled)',
    status: 'running',
    features: [
      '✅ No duplicate driver records',
      '✅ Latest SMS data only',
      '✅ Unique driver constraint',
      '✅ Update tracking'
    ],
    endpoints: {
      health: '/api/health',
      drivers: '/api/drivers',
      driverById: '/api/drivers/:driverId',
      safeDrivers: '/api/drivers/safe',
      dangerDrivers: '/api/drivers/danger',
      stats: '/api/stats',
      smsReceive: '/api/sms/receive (POST)',
      cleanup: '/api/admin/cleanup-duplicates (POST)'
    },
    timestamp: new Date().toISOString()
  });
});

// ✅ Add global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit in production - just log
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error);
  // Exit on uncaught exceptions
  process.exit(1);
});

// ✅ Add memory monitoring
setInterval(() => {
  const used = process.memoryUsage();
  console.log('💾 Memory usage:', {
    rss: Math.round(used.rss / 1024 / 1024) + 'MB',
    heapTotal: Math.round(used.heapTotal / 1024 / 1024) + 'MB',
    heapUsed: Math.round(used.heapUsed / 1024 / 1024) + 'MB',
    connections: activeConnections.size
  });
}, 60000); // Every minute

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for connections`);
  console.log(`🔗 API endpoints available at http://localhost:${PORT}/api/`);
  console.log(`✅ Driver status: SAFE or DANGER only`);
  console.log(`🆕 Deduplication: Enabled (only latest SMS per driver)`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 Shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close();
    process.exit(0);
  });
});