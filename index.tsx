import { GoogleGenAI, Chat, GenerateContentResponse, Type } from "@google/genai";

// Fix: Declare the global 'L' variable for the Leaflet.js library to resolve TypeScript "Cannot find name 'L'" errors.
declare var L: any;

// --- STATE & CONFIG ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    throw new Error("API_KEY environment variable not set.");
}
const ai = new GoogleGenAI({ apiKey: API_KEY });
let chat: Chat | null = null;
let map: any;
let routingControl: any = null;
let spotMarker: any = null;
let weatherConditionsLayer: any = null;
let weatherInterval: number | null = null;
let liveLocationWatchId: number | null = null;
let liveLocationMarker: any = null;
let currentRoute: any = null;
let routeWeatherSummary = "";
let currentMode: 'spot' | 'route' = 'spot';


// --- DOM ELEMENTS ---
const form = document.getElementById('forecast-form')!;
const submitButton = document.getElementById('submit-button') as HTMLButtonElement;
const loadingIndicator = document.getElementById('loading-indicator')!;
const riskDisplay = document.getElementById('risk-display')!;
const welcomeMessage = document.getElementById('welcome-message')!;
const errorMessage = document.getElementById('error-message')!;
const errorText = document.getElementById('error-text')!;
const canvas = document.getElementById('radar-chart') as HTMLCanvasElement;
const latInput = document.getElementById('lat') as HTMLInputElement;
const lonInput = document.getElementById('lon') as HTMLInputElement;
const locationInput = document.getElementById('location') as HTMLInputElement;
const startLocationInput = document.getElementById('start-location') as HTMLInputElement;
const notifyBtn = document.getElementById('notify-btn') as HTMLButtonElement;
const chatForm = document.getElementById('chat-form')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatSubmit = document.getElementById('chat-submit') as HTMLButtonElement;
const chatContainer = document.getElementById('chat-container')!;
const mapError = document.getElementById('map-error')!;
const startLocationWrapper = document.getElementById('start-location-wrapper')!;
const locationLabel = document.getElementById('location-label')!;
const latLabel = document.getElementById('lat-label')!;
const lonLabel = document.getElementById('lon-label')!;
const mapHelperText = document.getElementById('map-helper-text')!;


const thresholds: { [key: string]: HTMLInputElement } = {
    hot: document.getElementById('threshold-hot') as HTMLInputElement,
    cold: document.getElementById('threshold-cold') as HTMLInputElement,
    windy: document.getElementById('threshold-windy') as HTMLInputElement,
    wet: document.getElementById('threshold-wet') as HTMLInputElement,
    humidity: document.getElementById('threshold-humidity') as HTMLInputElement,
};

const valueDisplays: { [key: string]: HTMLElement } = {
    hot: document.getElementById('value-hot')!,
    cold: document.getElementById('value-cold')!,
    windy: document.getElementById('value-windy')!,
    wet: document.getElementById('value-wet')!,
    humidity: document.getElementById('value-humidity')!,
};

// --- ICON DEFINITIONS ---
const rainIcon = L.divIcon({
    className: 'rain-icon-marker',
    iconSize: [32, 32],
    iconAnchor: [16, 32]
});

const thunderstormIcon = L.divIcon({
    className: 'thunderstorm-icon-marker',
    iconSize: [32, 32],
    iconAnchor: [16, 32]
});


// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    initializePage();
});

function initializePage() {
    setMinDate();
    initializeThresholds();
    setupEventListeners();
    if (typeof L !== 'undefined') {
        initializeMap();
    } else {
        console.error("Leaflet is not available.");
    }
    if (localStorage.getItem('geosphereTripDetails')) {
        startWeatherMonitoring(true); 
    }
}

// --- SETUP FUNCTIONS ---

function setMinDate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    let mm = (today.getMonth() + 1).toString().padStart(2, '0');
    let dd = today.getDate().toString().padStart(2, '0');
    const minDate = `${yyyy}-${mm}-${dd}`;
    const dateInput = document.getElementById('date') as HTMLInputElement;
    dateInput.setAttribute('min', minDate);
    dateInput.value = minDate;
}

function initializeThresholds() {
    updateRangeValue('hot', '°C');
    updateRangeValue('cold', '°C');
    updateRangeValue('windy', 'km/h');
    updateRangeValue('wet', 'mm/day');
    updateRangeValue('humidity', '%');
}

function setupEventListeners() {
    form.addEventListener('submit', handleForecastSubmit);
    locationInput.addEventListener('change', (e) => geocodeLocation((e.target as HTMLInputElement).value));
    startLocationInput.addEventListener('change', handleStartLocationChange);
    document.getElementById('live-location-btn')!.addEventListener('click', getCurrentLocation);
    notifyBtn.addEventListener('click', handleNotificationClick);
    chatForm.addEventListener('submit', handleChatSubmit);

    document.querySelectorAll('input[name="forecast-mode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            setForecastMode((e.target as HTMLInputElement).value as 'spot' | 'route');
        });
    });

    Object.keys(thresholds).forEach(id => {
        const unit = id === 'hot' || id === 'cold' ? '°C'
                     : id === 'windy' ? 'km/h'
                     : id === 'wet' ? 'mm/day'
                     : '%';
        thresholds[id].addEventListener('input', () => updateRangeValue(id, unit));
    });
}

// --- MODE SWITCHING ---

function setForecastMode(newMode: 'spot' | 'route') {
    if (newMode === currentMode) return;
    currentMode = newMode;
    hideMapError();
    weatherConditionsLayer.clearLayers();

    if (newMode === 'spot') {
        startLocationWrapper.classList.add('hidden');
        locationLabel.textContent = 'Location';
        latLabel.textContent = 'Latitude (N/S)';
        lonLabel.textContent = 'Longitude (E/W)';
        mapHelperText.textContent = 'Drag the marker or type a location to set the precise coordinates.';
        setupSpotMap();
    } else { // 'route'
        startLocationWrapper.classList.remove('hidden');
        locationLabel.textContent = 'End Destination';
        latLabel.textContent = 'Destination Latitude (N/S)';
        lonLabel.textContent = 'Destination Longitude (E/W)';
        mapHelperText.textContent = 'Drag markers or type a location to update the route. Weather conditions are marked with icons.';
        setupRouteMap();
    }
}

// --- MAP & GEOLOCATION ---

function initializeMap() {
    const initialLat = parseFloat(latInput.value) || 36.10;
    const initialLon = parseFloat(lonInput.value) || -112.11;

    map = L.map('map-container').setView([initialLat, initialLon], 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    
    weatherConditionsLayer = L.layerGroup().addTo(map);
    
    // Initial setup is for 'spot' mode
    setupSpotMap();
    
    // Add Live Location Tracking Control
    L.Control.Track = L.Control.extend({
        onAdd: function(map: any) {
            const btn = L.DomUtil.create('a', 'leaflet-bar leaflet-control leaflet-control-custom leaflet-control-track');
            btn.href = '#';
            btn.title = 'Track my live location';
            
            L.DomEvent.on(btn, 'click', L.DomEvent.stopPropagation)
                      .on(btn, 'click', L.DomEvent.preventDefault)
                      .on(btn, 'click', () => toggleLiveLocationTracking(btn));
            return btn;
        },
        onRemove: function(map: any) {}
    });
    L.control.track = function(opts: any) { return new L.Control.Track(opts); }
    L.control.track({ position: 'topleft' }).addTo(map);

    setTimeout(() => map.invalidateSize(), 100);
}

function setupSpotMap() {
    if (routingControl) {
        map.removeControl(routingControl);
        routingControl = null;
    }
    weatherConditionsLayer.clearLayers();
    currentRoute = null;
    routeWeatherSummary = "";

    const initialLat = parseFloat(latInput.value) || 36.10;
    const initialLon = parseFloat(lonInput.value) || -112.11;
    
    spotMarker = L.marker([initialLat, initialLon], { draggable: true }).addTo(map);
    
    spotMarker.on('dragend', (e: any) => {
        const latlng = e.target.getLatLng();
        updateCoordinateInputs(latlng.lat, latlng.lng);
        reverseGeocode(latlng.lat, latlng.lng);
    });

    map.on('click', (e: any) => {
        if(currentMode === 'spot') {
            const latlng = e.latlng;
            spotMarker.setLatLng(latlng);
            updateCoordinateInputs(latlng.lat, latlng.lng);
            reverseGeocode(latlng.lat, latlng.lng);
        }
    });
}

function setupRouteMap() {
    if (spotMarker) {
        map.removeLayer(spotMarker);
        spotMarker = null;
    }
    map.off('click'); // Remove spot-specific click listener
    weatherConditionsLayer.clearLayers();
    
    const waypoints = [ L.latLng(parseFloat(latInput.value), parseFloat(lonInput.value)) ];
    if(startLocationInput.value) {
      // If a start location exists, we need to geocode it and add it. For simplicity, we'll just add a placeholder.
      // A more robust solution would geocode startLocationInput.value here.
    }

    routingControl = L.Routing.control({
        waypoints: waypoints,
        routeWhileDragging: true,
        geocoder: null,
        addWaypoints: false,
        draggableWaypoints: true
    }).addTo(map);

    routingControl.on('waypointschanged', (e: any) => {
        const waypoints = e.waypoints;
        const endWp = waypoints[waypoints.length - 1];
        if (endWp && endWp.latLng) {
            updateCoordinateInputs(endWp.latLng.lat, endWp.latLng.lng);
            reverseGeocode(endWp.latLng.lat, endWp.latLng.lng, 'end');
        }
        if (waypoints.length > 1) {
            const startWp = waypoints[0];
            if (startWp && startWp.latLng) {
                reverseGeocode(startWp.latLng.lat, startWp.latLng.lng, 'start');
            }
        }
    });

    routingControl.on('routesfound', async (e: any) => {
        hideMapError();
        if (e.routes && e.routes.length > 0) {
            currentRoute = e.routes[0];
            await displayWeatherOnRoute(currentRoute);
        } else {
            currentRoute = null;
            routeWeatherSummary = "";
            weatherConditionsLayer.clearLayers();
        }
    });
    routingControl.on('routingerror', (e: any) => {
        console.error('Routing Error:', e.error);
        showMapError(`Could not find a route. Please ensure both locations are routable.`);
        weatherConditionsLayer.clearLayers();
        currentRoute = null;
        routeWeatherSummary = "";
    });
}


async function geocodeLocation(locationName: string) {
    if (!locationName) return;
    hideMapError();
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Geocoding service failed.');
        const data = await response.json();
        if (data.length > 0) {
            const { lat, lon } = data[0];
            const newLatLng = L.latLng(parseFloat(lat), parseFloat(lon));
            
            if (currentMode === 'spot' && spotMarker) {
                spotMarker.setLatLng(newLatLng);
                updateCoordinateInputs(newLatLng.lat, newLatLng.lng);
            } else if (currentMode === 'route' && routingControl) {
                const waypoints = routingControl.getWaypoints();
                waypoints[waypoints.length - 1].latLng = newLatLng;
                routingControl.setWaypoints(waypoints);
            }
            map.panTo(newLatLng);
        }
    } catch (error) {
        console.error("Geocoding error:", error);
    }
}

async function handleStartLocationChange(e: Event) {
    const locationName = (e.target as HTMLInputElement).value;
    if (currentMode !== 'route' || !routingControl) return;
    
    const waypoints = routingControl.getWaypoints();
    hideMapError();
    weatherConditionsLayer.clearLayers();

    if (!locationName) {
        if (waypoints.length > 1) {
            routingControl.setWaypoints(waypoints.slice(1));
        }
        return;
    }

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(locationName)}&format=json&limit=1`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Geocoding service failed.');
        const data = await response.json();
        if (data.length > 0) {
            const { lat, lon } = data[0];
            const newLatLng = L.latLng(parseFloat(lat), parseFloat(lon));
            let newWaypoints;
            if (waypoints.length > 1) {
                waypoints[0].latLng = newLatLng;
                newWaypoints = waypoints;
            } else {
                newWaypoints = [newLatLng, waypoints[0].latLng];
            }
            routingControl.setWaypoints(newWaypoints);
            map.fitBounds(L.latLngBounds(newWaypoints.map((wp: any) => wp.latLng)));
        }
    } catch (error) {
        console.error("Start location geocoding error:", error);
    }
}

async function reverseGeocode(lat: number, lon: number, type: 'start' | 'end' = 'end') {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Reverse geocoding failed.');
        const data = await response.json();
        const inputToUpdate = (type === 'start' || currentMode === 'route') ? startLocationInput : locationInput;
        if(currentMode === 'spot') {
            locationInput.value = data?.display_name || 'Custom Location';
        } else {
            if (type === 'start') startLocationInput.value = data?.display_name || 'Custom Location';
            else locationInput.value = data?.display_name || 'Custom Location';
        }
    } catch (error) {
        console.error("Reverse geocoding error:", error);
         if(currentMode === 'spot') {
            locationInput.value = 'Custom Location';
        } else {
            if (type === 'start') startLocationInput.value = 'Custom Location';
            else locationInput.value = 'Custom Location';
        }
    }
}

function getCurrentLocation() {
    if (!navigator.geolocation) {
        showError("Geolocation is not supported by your browser.");
        return;
    }
    const btn = document.getElementById('live-location-btn') as HTMLButtonElement;
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            const newLatLng = L.latLng(latitude, longitude);
            
             if (currentMode === 'spot' && spotMarker) {
                spotMarker.setLatLng(newLatLng);
                updateCoordinateInputs(newLatLng.lat, newLatLng.lng);
                reverseGeocode(newLatLng.lat, newLatLng.lng);
            } else if (currentMode === 'route' && routingControl) {
                const waypoints = routingControl.getWaypoints();
                waypoints[waypoints.length - 1].latLng = newLatLng;
                routingControl.setWaypoints(waypoints);
            }

            map.panTo(newLatLng);
            btn.disabled = false;
        },
        (err) => {
            showError(`Unable to retrieve location: ${err.message}`);
            btn.disabled = false;
        }
    );
}

// --- LIVE LOCATION TRACKING ---

function toggleLiveLocationTracking(btn: HTMLElement) {
    if (liveLocationWatchId) {
        stopLiveLocationTracking(btn);
    } else {
        startLiveLocationTracking(btn);
    }
}

function startLiveLocationTracking(btn: HTMLElement) {
    if (!navigator.geolocation) {
        showError("Geolocation is not supported by your browser.");
        return;
    }
    
    btn.classList.add('active');

    const pulsingIcon = L.divIcon({
        className: 'live-location-marker',
        iconSize: [16, 16]
    });

    liveLocationWatchId = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            const latLng = L.latLng(latitude, longitude);

            if (!liveLocationMarker) {
                liveLocationMarker = L.marker(latLng, { icon: pulsingIcon }).addTo(map);
            } else {
                liveLocationMarker.setLatLng(latLng);
            }
            map.setView(latLng, 16);
        },
        (error) => {
            showError(`Live tracking error: ${error.message}`);
            stopLiveLocationTracking(btn);
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        }
    );
}

function stopLiveLocationTracking(btn: HTMLElement) {
    if (liveLocationWatchId) {
        navigator.geolocation.clearWatch(liveLocationWatchId);
        liveLocationWatchId = null;
    }
    if (liveLocationMarker) {
        map.removeLayer(liveLocationMarker);
        liveLocationMarker = null;
    }
    btn.classList.remove('active');
}


// --- UI UPDATE FUNCTIONS ---

function updateRangeValue(id: string, unit: string) {
    valueDisplays[id].textContent = `${thresholds[id].value} ${unit}`;
}

function updateCoordinateInputs(lat: number, lon: number) {
    latInput.value = lat.toFixed(2);
    lonInput.value = lon.toFixed(2);
}

function setUIState(state: 'loading' | 'results' | 'welcome' | 'error') {
    loadingIndicator.classList.toggle('hidden', state !== 'loading');
    riskDisplay.classList.toggle('hidden', state !== 'results');
    welcomeMessage.classList.toggle('hidden', state !== 'welcome');
    errorMessage.classList.toggle('hidden', state !== 'error');

    submitButton.disabled = state === 'loading';
    submitButton.setAttribute('aria-busy', (state === 'loading').toString());
    submitButton.textContent = state === 'loading' ? 'Analyzing...' : 'Get AI Adversity Forecast';
}

function showError(message: string) {
    setUIState('error');
    errorText.textContent = message;
}

function showMapError(message: string) {
    mapError.textContent = message;
    mapError.classList.remove('hidden');
}

function hideMapError() {
    if (!mapError.classList.contains('hidden')) {
        mapError.textContent = '';
        mapError.classList.add('hidden');
    }
}


// --- FORECAST LOGIC ---

async function handleForecastSubmit(e: Event) {
    e.preventDefault();
    hideMapError();
    setUIState('loading');
    weatherConditionsLayer.clearLayers();
    
    const date = (document.getElementById('date') as HTMLInputElement).value;
    const lat = latInput.value;
    const lon = lonInput.value;
    const activity = (document.getElementById('activity') as HTMLSelectElement).value;
    
    const userThresholds = {
        hot: thresholds.hot.value,
        cold: thresholds.cold.value,
        windy: thresholds.windy.value,
        wet: thresholds.wet.value,
        humidity: thresholds.humidity.value
    };

    try {
        const weatherData = await getWeatherData(lat, lon, date);
        if (!weatherData) {
            throw new Error("Could not fetch weather data. Please check the location and date.");
        }
        
        if (currentMode === 'spot') {
            displayWeatherForSpot(weatherData, lat, lon);
        }

        const tripContext = { 
            lat, 
            lon, 
            activity, 
            date,
            location: locationInput.value,
            startLocation: currentMode === 'route' ? startLocationInput.value : null,
            routeWeatherSummary: currentMode === 'route' ? routeWeatherSummary : ""
        };
        const geminiResponse = await generateAdversityForecast(weatherData, userThresholds, tripContext);
        
        renderResults(geminiResponse);
        setUIState('results');

    } catch (error) {
        console.error(error);
        showError(error instanceof Error ? error.message : "An unknown error occurred.");
    }
}

async function getWeatherData(lat: string, lon: string, date: string) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min,windspeed_10m_max,precipitation_sum&hourly=relativehumidity_2m&timezone=auto&start_date=${date}&end_date=${date}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Weather API request failed with status ${response.status}`);
        }
        const data = await response.json();
        if (!data.daily || !data.daily.time || data.daily.time.length === 0) {
            console.warn(`No weather data for ${lat},${lon}`);
            return null;
        }
        const maxHumidity = Math.max(...data.hourly.relativehumidity_2m);
        
        return {
            temp_max: data.daily.temperature_2m_max[0],
            temp_min: data.daily.temperature_2m_min[0],
            wind_kph: data.daily.windspeed_10m_max[0],
            precip_mm: data.daily.precipitation_sum[0],
            humidity_percent: maxHumidity,
            weathercode: data.daily.weathercode[0]
        };
    } catch (error) {
        console.error("Weather API Error:", error);
        return null;
    }
}

async function generateAdversityForecast(weatherData: any, userThresholds: any, tripContext: any) {
    const model = "gemini-2.5-flash";
    const prompt = `
        Analyze the following weather forecast data for a planned trip and provide a personalized adversity forecast.

        *Trip Context:*
        - Forecast Mode: ${tripContext.startLocation ? 'Route' : 'Spot'}
        ${tripContext.startLocation ? `- Start Location: ${tripContext.startLocation}` : ''}
        - Location/Destination: ${tripContext.location} (Lat: ${tripContext.lat}, Lon: ${tripContext.lon})
        - Date: ${tripContext.date}
        - Activity: ${tripContext.activity}
        ${tripContext.routeWeatherSummary ? `- Additional Info: ${tripContext.routeWeatherSummary}` : ''}

        *User's Personal Adversity Thresholds (what they consider "Very" adverse):*
        - Very Hot: > ${userThresholds.hot} °C
        - Very Cold: < ${userThresholds.cold} °C
        - Very Windy: > ${userThresholds.windy} km/h
        - Very Wet: > ${userThresholds.wet} mm/day
        - Very Humid: > ${userThresholds.humidity} %

        *Weather Forecast Data (for Location/Destination):*
        - Max Temperature: ${weatherData.temp_max} °C
        - Min Temperature: ${weatherData.temp_min} °C
        - Max Wind Speed: ${weatherData.wind_kph} km/h
        - Total Precipitation: ${weatherData.precip_mm} mm
        - Max Relative Humidity: ${weatherData.humidity_percent} %
        - Weather Condition Code: ${weatherData.weathercode} (WMO Code)

        Based on this information, generate a JSON response. The likelihood scores should be calculated by comparing the forecast data against the user's thresholds. The overall_adversity_score is a weighted average of the individual likelihoods, considering the activity type and travel context if provided.
        `;
        
        const schema = {
            type: Type.OBJECT,
            properties: {
                overall_adversity_score: { type: Type.INTEGER, description: "A single score from 0 to 100 representing the total risk."},
                risk_level: { type: Type.STRING, description: "A qualitative assessment (e.g., 'Low Risk', 'Moderate Risk', 'High Risk')." },
                risk_breakdown: {
                    type: Type.OBJECT,
                    properties: {
                        hot: { type: Type.INTEGER, description: "Likelihood score (0-100) of it being 'Very Hot'." },
                        cold: { type: Type.INTEGER, description: "Likelihood score (0-100) of it being 'Very Cold'." },
                        windy: { type: Type.INTEGER, description: "Likelihood score (0-100) of it being 'Very Windy'." },
                        wet: { type: Type.INTEGER, description: "Likelihood score (0-100) of it being 'Very Wet'." },
                        humid: { type: Type.INTEGER, description: "Likelihood score (0-100) of it being 'Very Humid'." }
                    },
                    required: ["hot", "cold", "windy", "wet", "humid"]
                },
                summary_narrative: { type: Type.STRING, description: "A 2-3 sentence human-readable summary of the conditions relative to the user's thresholds and activity. Mention rainy spots or thunderstorms on the route if applicable." },
                safety_recommendations: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "A list of 3-4 actionable safety tips or recommendations based on the primary risks."
                },
                sustainability_tip: { type: Type.STRING, description: "A brief, relevant sustainability tip if applicable."}
            },
            required: ["overall_adversity_score", "risk_level", "risk_breakdown", "summary_narrative", "safety_recommendations"]
        };

    try {
        const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        });

        const jsonText = response.text.trim();
        return JSON.parse(jsonText);
    } catch (error) {
        console.error("Gemini API Error:", error);
        throw new Error("The AI forecast model could not generate a response. Please try again.");
    }
}


// --- RENDERING RESULTS ---

function renderResults(data: any) {
    const overallScoreEl = document.getElementById('overall-score')!;
    const overallMessageEl = document.getElementById('overall-message')!;
    const score = data.overall_adversity_score;

    let color, message = data.risk_level;
    if (score < 20) { color = '#10b981'; } 
    else if (score < 40) { color = '#4ade80'; } 
    else if (score < 60) { color = '#facc15'; } 
    else if (score < 80) { color = '#f97316'; } 
    else { color = '#ef4444'; }

    overallScoreEl.textContent = `${score}%`;
    overallScoreEl.style.color = color;
    overallMessageEl.textContent = message;
    overallMessageEl.style.color = color;

    document.getElementById('ai-summary')!.textContent = data.summary_narrative;

    const recommendationsEl = document.getElementById('ai-recommendations')!;
    recommendationsEl.innerHTML = `<p class="text-lg font-semibold border-t border-gray-700 pt-3 mb-2">Recommendations:</p>
        <ul class="list-disc list-inside space-y-1 text-gray-400">
            ${data.safety_recommendations.map((item: string) => `<li>${item}</li>`).join('')}
            ${data.sustainability_tip ? `<li class="mt-2 text-cyan-400/80">🌱 ${data.sustainability_tip}</li>` : ''}
        </ul>
    `;

    drawRadarChart(data.risk_breakdown);
}

function drawRadarChart(riskData: { hot: number; cold: number; windy: number; wet: number; humid: number; }) {
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    const R = Math.min(W, H) / 2 * 0.8;
    const centerX = W / 2;
    const centerY = H / 2;
    const riskLabels = ['Hot', 'Cold', 'Windy', 'Wet', 'Humid'];
    const riskScores = [riskData.hot, riskData.cold, riskData.windy, riskData.wet, riskData.humid];
    const numPoints = riskLabels.length;

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = '#374151';
    ctx.fillStyle = '#9ca3af';
    ctx.font = '12px Inter, sans-serif';

    for (let i = 0; i < numPoints; i++) {
        const angle = (Math.PI / 2) - (i * 2 * Math.PI / numPoints);
        const x = centerX + R * Math.cos(angle);
        const y = centerY - R * Math.sin(angle);
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(x, y);
        ctx.stroke();
        const labelX = centerX + (R + 20) * Math.cos(angle);
        const labelY = centerY - (R + 20) * Math.sin(angle);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(riskLabels[i], labelX, labelY);
    }

    for (let level = 25; level <= 100; level += 25) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, R * (level / 100), 0, 2 * Math.PI);
        ctx.stroke();
    }

    ctx.beginPath();
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(6, 182, 212, 0.4)';

    riskScores.forEach((score, i) => {
        const angle = (Math.PI / 2) - (i * 2 * Math.PI / numPoints);
        const radius = R * (score / 100);
        const x = centerX + radius * Math.cos(angle);
        const y = centerY - radius * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
}

function isRainCode(code: number): boolean {
    // WMO Weather interpretation codes for drizzle, rain, and showers
    return (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
}

function displayWeatherForSpot(weatherData: any, lat: string, lon: string) {
    const code = weatherData.weathercode;
    const latLng = L.latLng(parseFloat(lat), parseFloat(lon));
    let icon = null;

    if ([95, 96, 99].includes(code)) {
        icon = thunderstormIcon;
    } else if (isRainCode(code)) {
        icon = rainIcon;
    }

    if (icon) {
        L.marker(latLng, { icon }).addTo(weatherConditionsLayer);
    }
}

async function displayWeatherOnRoute(route: any): Promise<void> {
    weatherConditionsLayer.clearLayers();
    routeWeatherSummary = "";
    const date = (document.getElementById('date') as HTMLInputElement).value;
    if (!date || !route.coordinates || route.coordinates.length < 2) {
        return;
    }

    const samplePoints = [];
    let distance = 0;
    const step = 50000; // Sample every 50km
    
    for(let i = 0; i < route.coordinates.length - 1; i++) {
        const start = route.coordinates[i];
        const end = route.coordinates[i+1];
        distance += start.distanceTo(end);
        if (distance >= step) {
            samplePoints.push(end);
            distance = 0;
        }
    }
    if (samplePoints.length === 0 && route.coordinates.length > 0) {
        samplePoints.push(route.coordinates[Math.floor(route.coordinates.length / 2)]);
    }

    const weatherPromises = samplePoints.map(point => getWeatherData(point.lat.toString(), point.lng.toString(), date));
    const weatherResults = await Promise.all(weatherPromises);
    
    let hasRain = false;
    let hasThunder = false;

    weatherResults.forEach((data, index) => {
        if (data) {
            const code = data.weathercode;
            let icon = null;
            if ([95, 96, 99].includes(code)) {
                icon = thunderstormIcon;
                hasThunder = true;
            } else if (isRainCode(code)) {
                icon = rainIcon;
                hasRain = true;
            }
            if (icon) {
                L.marker(samplePoints[index], { icon }).addTo(weatherConditionsLayer);
            }
        }
    });

    if (hasThunder) {
        routeWeatherSummary = "Thunderstorms are forecast for parts of the route.";
    } else if (hasRain) {
        routeWeatherSummary = "Rain is forecast for parts of the route.";
    }
}


// --- CHAT FUNCTIONS ---

function appendMessage(sender: 'user' | 'ai', message: string) {
    const messageEl = document.createElement('div');
    messageEl.className = `p-3 rounded-lg max-w-[80%] mb-2 ${
        sender === 'user' ? 'bg-gray-700 ml-auto' : 'bg-gray-800 mr-auto'
    }`;
    messageEl.textContent = message;
    chatContainer.appendChild(messageEl);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function handleChatSubmit(e: Event) {
    e.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;

    appendMessage('user', message);
    chatInput.value = '';
    chatSubmit.disabled = true;

    if (!chat) {
        chat = ai.chats.create({
            model: "gemini-2.5-flash",
            config: {
                systemInstruction: "You are a helpful and knowledgeable weather and travel assistant for the Geosphere app. Your primary function is to answer questions about weather, travel, and risk mitigation, especially in the context of the user's last generated weather forecast. Keep your answers concise and focused on safety and travel advice. Do not mention API keys or implementation details."
            }
        });
    }

    try {
        const response: GenerateContentResponse = await chat.sendMessage({ message });
        const aiMessage = response.text;
        appendMessage('ai', aiMessage);
    } catch (error) {
        console.error("Chat Error:", error);
        appendMessage('ai', "I'm sorry, I encountered an error. Could you please try asking again?");
    } finally {
        chatSubmit.disabled = false;
    }
}

// --- NOTIFICATIONS ---

async function checkWeatherForAlerts() {
    const detailsString = localStorage.getItem('geosphereTripDetails');
    if (!detailsString) {
        stopWeatherMonitoring();
        return;
    }

    const tripDetails = JSON.parse(detailsString);
    const { lat, lon, date, location, thresholds } = tripDetails;
    const today = new Date();
    const tripDate = new Date(date + 'T00:00:00');

    if (tripDate < today) {
        stopWeatherMonitoring();
        return;
    }

    try {
        const weatherData = await getWeatherData(lat, lon, date);
        if (!weatherData) return;
        const sentAlerts = JSON.parse(localStorage.getItem('geosphereSentAlerts') || '{}');
        let alertTriggered = false;
        let alertBody = `Weather for ${location} on ${date}:\n`;

        if (weatherData.temp_max > thresholds.hot) {
            alertBody += `- High of ${weatherData.temp_max}°C exceeds your hot threshold of ${thresholds.hot}°C.\n`;
            alertTriggered = true;
        }
        if (weatherData.temp_min < thresholds.cold) {
            alertBody += `- Low of ${weatherData.temp_min}°C is below your cold threshold of ${thresholds.cold}°C.\n`;
            alertTriggered = true;
        }
        if (weatherData.wind_kph > thresholds.windy) {
            alertBody += `- Max wind speed of ${weatherData.wind_kph} km/h exceeds your windy threshold of ${thresholds.windy} km/h.\n`;
            alertTriggered = true;
        }
        if (weatherData.precip_mm > thresholds.wet) {
            alertBody += `- Total precipitation of ${weatherData.precip_mm} mm exceeds your wet threshold of ${thresholds.wet} mm/day.\n`;
            alertTriggered = true;
        }
        
        const todayKey = today.toISOString().split('T')[0];
        if (alertTriggered && !sentAlerts[todayKey]) {
            new Notification('GEOSPHERE Weather ALERT ⚠', {
                body: alertBody,
                icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚠</text></svg>'
            });
            sentAlerts[todayKey] = true;
            localStorage.setItem('geosphereSentAlerts', JSON.stringify(sentAlerts));
        }

    } catch (error) {
        console.error("Error checking weather for alerts:", error);
    }
}

function stopWeatherMonitoring() {
    if (weatherInterval !== null) {
        clearInterval(weatherInterval);
        weatherInterval = null;
    }
    localStorage.removeItem('geosphereTripDetails');
    localStorage.removeItem('geosphereSentAlerts');

    notifyBtn.textContent = 'Enable Weather Alerts 🔔';
    notifyBtn.title = 'Click to enable hourly weather monitoring';
    notifyBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
    notifyBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');

    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('GEOSPHERE Alerts Disabled', {
            body: 'Weather monitoring has been stopped.',
            icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🛑</text></svg>'
        });
    }
}


async function handleNotificationClick() {
    if (weatherInterval) {
        stopWeatherMonitoring();
    } else {
        if (!('Notification' in window)) {
            alert('This browser does not support desktop notification.');
            return;
        }

        if (Notification.permission === 'granted') {
            startWeatherMonitoring(false);
        } else if (Notification.permission !== 'denied') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                startWeatherMonitoring(false);
            }
        } else {
            alert('Notification permission has been denied. Please enable it in your browser settings.');
        }
    }
}

function startWeatherMonitoring(isResuming = false) {
    if (weatherInterval) return;

    const date = (document.getElementById('date') as HTMLInputElement).value;
    const lat = latInput.value;
    const lon = lonInput.value;
    
    if (!date || !lat || !lon || !locationInput.value) {
        if (!isResuming) alert('Please select a location and date before enabling notifications.');
        return;
    }
    
    const tripDate = new Date(date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (tripDate < today) {
        if (!isResuming) alert('Cannot set notifications for a past date.');
        stopWeatherMonitoring();
        return;
    }

    const tripDetails = {
        lat,
        lon,
        date,
        location: locationInput.value,
        thresholds: {
            hot: parseFloat(thresholds.hot.value),
            cold: parseFloat(thresholds.cold.value),
            windy: parseFloat(thresholds.windy.value),
            wet: parseFloat(thresholds.wet.value),
            humidity: parseFloat(thresholds.humidity.value),
        }
    };

    localStorage.setItem('geosphereTripDetails', JSON.stringify(tripDetails));
    
    if (!isResuming) {
        localStorage.removeItem('geosphereSentAlerts');
        new Notification('GEOSPHERE Alerts Enabled', {
            body: `We will monitor the weather for ${tripDetails.location} on ${tripDetails.date}.`,
            icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌍</text></svg>'
        });
    }

    checkWeatherForAlerts();
    weatherInterval = window.setInterval(checkWeatherForAlerts, 3600000); // Check every hour

    notifyBtn.textContent = 'Monitoring Active ✅';
    notifyBtn.title = 'Click to disable notifications';
    notifyBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700'); 
    notifyBtn.classList.add('bg-red-600', 'hover:bg-red-700'); 
}